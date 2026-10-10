import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { incidentListQuerySchema, incidentSchema, incidentUpdateSchema, maintenanceNoticeSchema } from '@crapplet/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions, StaffOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { IncidentsService } from './incidents.service';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;
const UUID = new ParseUUIDPipe();

/**
 * Incidents and maintenance notices. Reading needs `tickets.read` (customers:
 * public items that affect them); writing is staff work with `alerts.manage`.
 */
@ApiTags('incidents')
@ApiCookieAuth()
@ApiBearerAuth()
@Controller({ path: 'status', version: '1' })
export class IncidentsController {
  constructor(private readonly svc: IncidentsService) {}

  @Get('incidents')
  @RequirePermissions('tickets.read')
  @ApiZodQuery(incidentListQuerySchema)
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(incidentListQuerySchema)) q: Infer<typeof incidentListQuerySchema>) {
    return this.svc.list(p, q);
  }

  @Get('incidents/:id')
  @RequirePermissions('tickets.read')
  get(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.get(p, id);
  }

  @Post('incidents')
  @StaffOnly()
  @RequirePermissions('tickets.read', 'alerts.manage')
  @ApiOperation({ summary: 'Open an incident. Public incidents are shown to customers at the affected site or named customers.' })
  @ApiZodBody(incidentSchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(incidentSchema)) b: Infer<typeof incidentSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.create(p, b, meta);
  }

  @Post('incidents/:id/updates')
  @StaffOnly()
  @RequirePermissions('tickets.read', 'alerts.manage')
  @ApiZodBody(incidentUpdateSchema)
  update(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(incidentUpdateSchema)) b: Infer<typeof incidentUpdateSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.update(p, id, b, meta);
  }

  @Get('maintenance')
  @RequirePermissions('tickets.read')
  @ApiOperation({ summary: 'Maintenance windows (customers: the ones published to them that affect their sites or equipment).' })
  maintenance(@CurrentPrincipal() p: Principal) {
    return this.svc.maintenance(p);
  }

  @Put('maintenance/:id/notice')
  @StaffOnly()
  @RequirePermissions('tickets.read', 'alerts.manage')
  @ApiZodBody(maintenanceNoticeSchema)
  notice(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(maintenanceNoticeSchema)) b: Infer<typeof maintenanceNoticeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.setNotice(p, id, b, meta);
  }

  @Get('customers')
  @StaffOnly()
  @RequirePermissions('tickets.read', 'alerts.manage')
  customers(@CurrentPrincipal() p: Principal) {
    return this.svc.customerOptions(p);
  }
}
