import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, ServiceUnavailableException, Sse, type MessageEvent } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { z } from 'zod';
import {
  RATE_RANGES,
  alertAckSchema,
  alertListQuerySchema,
  alertRuleSchema,
  channelSchema,
  deviceMonitoringSchema,
  maintenanceSchema,
  monitoringSettingsSchema,
  portListQuerySchema,
  rateHistoryQuerySchema,
} from '@crapplet/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions, StaffOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { MonitoringService } from './monitoring.service';
import { AlertsService } from './alerts.service';
import { MonitoringStream } from './stream.service';
import type { MonitoringEvent } from './events';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;
const UUID = new ParseUUIDPipe();
const totalsQuery = z.object({ datacenterId: z.string().uuid().optional(), range: z.enum(RATE_RANGES).default('24h') });
const deliveriesQuery = z.object({ channelId: z.string().uuid().optional() });

/* ------------------------------------------------------------ monitoring */

@ApiTags('monitoring')
@ApiCookieAuth()
@Controller({ path: 'monitoring', version: '1' })
export class MonitoringController {
  constructor(
    private readonly svc: MonitoringService,
    private readonly stream: MonitoringStream,
  ) {}

  @Get('ports')
  @RequirePermissions('monitoring.read')
  @ApiOperation({ summary: 'Monitored ports with their latest measured rates. Customers see their own ports and the ports cabled to them.' })
  @ApiZodQuery(portListQuerySchema)
  ports(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(portListQuerySchema)) q: Infer<typeof portListQuerySchema>) {
    return this.svc.ports(p, q);
  }

  @Get('ports/:id')
  @RequirePermissions('monitoring.read')
  port(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.port(p, id);
  }

  @Get('ports/:id/history')
  @RequirePermissions('monitoring.read')
  @ApiOperation({ summary: 'Rate history (raw up to 6 h, 5-minute up to 7 d, hourly for 30 d) and the 95th percentile of 5-minute averages.' })
  @ApiZodQuery(rateHistoryQuerySchema)
  history(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Query(new ZodPipe(rateHistoryQuerySchema)) q: Infer<typeof rateHistoryQuerySchema>) {
    return this.svc.history(p, id, q.range);
  }

  @Get('totals')
  @StaffOnly()
  @RequirePermissions('monitoring.read')
  @ApiOperation({ summary: 'Current traffic summed over ports marked "count in totals" (a LAG and its members are counted once).' })
  @ApiZodQuery(totalsQuery)
  totals(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(totalsQuery)) q: Infer<typeof totalsQuery>) {
    return this.svc.totals(p, q.datacenterId);
  }

  @Get('totals/history')
  @StaffOnly()
  @RequirePermissions('monitoring.read')
  @ApiZodQuery(totalsQuery)
  totalsHistory(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(totalsQuery)) q: Infer<typeof totalsQuery>) {
    return this.svc.totalsHistory(p, q.range, q.datacenterId);
  }

  @Get('devices')
  @StaffOnly()
  @RequirePermissions('monitoring.read')
  @ApiOperation({ summary: 'Polling configuration and health per device.' })
  devices(@CurrentPrincipal() p: Principal) {
    return this.svc.devices(p);
  }

  @Put('devices/:id')
  @StaffOnly()
  @RequirePermissions('monitoring.configure')
  @ApiOperation({ summary: 'Enable or change polling for a device. Uses the stored read-only credential of the chosen kind; polling never changes the device.' })
  @ApiZodBody(deviceMonitoringSchema)
  configure(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(deviceMonitoringSchema)) b: Infer<typeof deviceMonitoringSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.configure(p, id, b, m);
  }

  @Delete('devices/:id')
  @StaffOnly()
  @RequirePermissions('monitoring.configure')
  unconfigure(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    return this.svc.unconfigure(p, id, m);
  }

  @Get('settings')
  @StaffOnly()
  @RequirePermissions('monitoring.read')
  settings(@CurrentPrincipal() p: Principal) {
    return this.svc.settings(p);
  }

  @Put('settings')
  @StaffOnly()
  @RequirePermissions('monitoring.configure')
  @ApiZodBody(monitoringSettingsSchema)
  updateSettings(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(monitoringSettingsSchema)) b: Infer<typeof monitoringSettingsSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.updateSettings(p, b, m);
  }

  /**
   * Server-Sent Events with live rates (and, for staff, alert changes).
   * Customers only receive ports they may see. A `hello` event says whether
   * the live feed (Redis) is up; `ping` keeps proxies from closing the stream.
   */
  @Sse('stream')
  @Header('X-Accel-Buffering', 'no')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('monitoring.read')
  @ApiOperation({ summary: 'Live monitoring events (text/event-stream).' })
  live(@CurrentPrincipal() p: Principal): Observable<MessageEvent> {
    const staff = p.userType === 'staff';
    return new Observable<MessageEvent>((sub) => {
      let visible: Set<string> | null = null;
      let closed = false;
      const refresh = async () => {
        if (staff) return;
        try {
          visible = await this.svc.visibleInterfaceIds(p);
        } catch {
          // keep the previous set
        }
      };
      const send = (ev: MonitoringEvent) => {
        if (closed) return;
        if (ev.type === 'alert') {
          if (staff) sub.next({ type: 'alert', data: ev });
          return;
        }
        if (staff) return sub.next({ type: 'rates', data: ev });
        if (!visible) return;
        const ports = ev.ports.filter((x) => visible!.has(x.interfaceId));
        // A customer learns nothing about devices they have no visible ports on.
        if (ports.length) sub.next({ type: 'rates', data: { ...ev, error: undefined, ports } });
      };
      const unsubscribe = this.stream.subscribe(p.orgId, send, p.userId);
      if (!unsubscribe) {
        sub.error(new ServiceUnavailableException({ error: 'too_many_streams', message: 'Too many live connections; try again shortly' }));
        return;
      }
      void Promise.all([refresh(), this.stream.ready()]).then(() => !closed && sub.next({ type: 'hello', data: { live: this.stream.live, at: new Date().toISOString() } }));
      const refreshTimer = staff ? null : setInterval(() => void refresh(), 60_000);
      const ping = setInterval(() => sub.next({ type: 'ping', data: { live: this.stream.live, at: new Date().toISOString() } }), 20_000);
      // Streams end after 15 minutes; the browser reconnects, which re-checks the
      // session and permissions (a revoked session can't keep a stream open).
      const lifetime = setTimeout(() => sub.complete(), 15 * 60_000);
      return () => {
        closed = true;
        unsubscribe();
        clearInterval(ping);
        clearTimeout(lifetime);
        if (refreshTimer) clearInterval(refreshTimer);
      };
    });
  }
}

/* ------------------------------------------------------------ alerts */

@ApiTags('alerts')
@ApiCookieAuth()
@StaffOnly()
@Controller({ path: 'alerts', version: '1' })
export class AlertsController {
  constructor(private readonly svc: AlertsService) {}

  @Get()
  @RequirePermissions('monitoring.read')
  @ApiZodQuery(alertListQuerySchema)
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(alertListQuerySchema)) q: Infer<typeof alertListQuerySchema>) {
    return this.svc.list(p, q);
  }

  @Get('summary')
  @RequirePermissions('monitoring.read')
  summary(@CurrentPrincipal() p: Principal) {
    return this.svc.summary(p);
  }

  @Post(':id/ack')
  @HttpCode(200)
  @RequirePermissions('alerts.manage')
  @ApiOperation({ summary: 'Acknowledge an alert (records who is handling it; does not change the device).' })
  @ApiZodBody(alertAckSchema)
  ack(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(alertAckSchema)) b: Infer<typeof alertAckSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.acknowledge(p, id, b.note, m);
  }

  // Rules ---------------------------------------------------------------

  @Get('rules')
  @RequirePermissions('monitoring.read')
  rules(@CurrentPrincipal() p: Principal) {
    return this.svc.rules(p);
  }

  @Post('rules')
  @RequirePermissions('alerts.manage')
  @ApiZodBody(alertRuleSchema)
  createRule(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(alertRuleSchema)) b: Infer<typeof alertRuleSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.createRule(p, b, m);
  }

  @Put('rules/:id')
  @RequirePermissions('alerts.manage')
  @ApiOperation({ summary: 'Replace a rule. Its firing alerts are closed and its evaluation restarts.' })
  @ApiZodBody(alertRuleSchema)
  updateRule(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(alertRuleSchema)) b: Infer<typeof alertRuleSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.updateRule(p, id, b, m);
  }

  @Delete('rules/:id')
  @RequirePermissions('alerts.manage')
  deleteRule(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    return this.svc.deleteRule(p, id, m);
  }

  // Maintenance -----------------------------------------------------------

  @Get('maintenance')
  @RequirePermissions('monitoring.read')
  maintenance(@CurrentPrincipal() p: Principal) {
    return this.svc.maintenance(p);
  }

  @Post('maintenance')
  @RequirePermissions('alerts.manage')
  @ApiZodBody(maintenanceSchema)
  createMaintenance(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(maintenanceSchema)) b: Infer<typeof maintenanceSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.createMaintenance(p, b, m);
  }

  @Put('maintenance/:id')
  @RequirePermissions('alerts.manage')
  @ApiZodBody(maintenanceSchema)
  updateMaintenance(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(maintenanceSchema)) b: Infer<typeof maintenanceSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.updateMaintenance(p, id, b, m);
  }

  @Delete('maintenance/:id')
  @RequirePermissions('alerts.manage')
  deleteMaintenance(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    return this.svc.deleteMaintenance(p, id, m);
  }

  // Channels --------------------------------------------------------------

  @Get('channels')
  @RequirePermissions('monitoring.read')
  channels(@CurrentPrincipal() p: Principal) {
    return this.svc.channels(p);
  }

  @Post('channels')
  @RequirePermissions('monitoring.configure')
  @ApiOperation({ summary: 'Create a notification channel. Secrets (SMTP password, signing secret, Slack URL, bot token) are encrypted and never returned.' })
  @ApiZodBody(channelSchema)
  createChannel(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(channelSchema)) b: Infer<typeof channelSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.createChannel(p, b, m);
  }

  @Put('channels/:id')
  @RequirePermissions('monitoring.configure')
  @ApiOperation({ summary: 'Replace a channel; secrets must be entered again.' })
  @ApiZodBody(channelSchema)
  updateChannel(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(channelSchema)) b: Infer<typeof channelSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.updateChannel(p, id, b, m);
  }

  @Delete('channels/:id')
  @RequirePermissions('monitoring.configure')
  deleteChannel(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    return this.svc.deleteChannel(p, id, m);
  }

  @Post('channels/:id/test')
  @HttpCode(202)
  @RequirePermissions('monitoring.configure')
  @ApiOperation({ summary: 'Queue a test message; the worker delivers it. Poll /alerts/notifications for the result.' })
  testChannel(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    return this.svc.testChannel(p, id, m);
  }

  @Get('notifications')
  @RequirePermissions('monitoring.read')
  @ApiZodQuery(deliveriesQuery)
  deliveries(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(deliveriesQuery)) q: Infer<typeof deliveriesQuery>) {
    return this.svc.deliveries(p, q.channelId);
  }
}
