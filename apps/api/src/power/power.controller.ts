import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  outletMappingSchema,
  powerDeviceListQuerySchema,
  powerExportQuerySchema,
  powerHistoryQuerySchema,
  powerPollingSchema,
  powerProfileSchema,
  powerSettingsSchema,
  powerSummaryQuerySchema,
  tariffSchema,
} from '@crapplet/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions, StaffOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { PowerService } from './power.service';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;
const UUID = new ParseUUIDPipe();
const dcQuery = z.object({ datacenterId: z.string().uuid().optional() });

/**
 * Equipment power. Reads need `power.read` (customers: their own devices,
 * without cost); configuration needs `power.configure` (staff). Collection
 * is read-only: nothing here switches outlets or changes a BMC.
 */
@ApiTags('power')
@ApiCookieAuth()
@Controller({ path: 'power', version: '1' })
export class PowerController {
  constructor(private readonly svc: PowerService) {}

  @Get('summary')
  @RequirePermissions('power.read')
  @ApiOperation({ summary: 'Current draw (measured and estimated kept apart, unknown devices counted), energy and cost for a period, by datacenter and category.' })
  @ApiZodQuery(powerSummaryQuerySchema)
  summary(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(powerSummaryQuerySchema)) q: Infer<typeof powerSummaryQuerySchema>) {
    return this.svc.summary(p, q.period, q.datacenterId);
  }

  @Get('devices')
  @RequirePermissions('power.read')
  @ApiZodQuery(powerDeviceListQuerySchema)
  devices(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(powerDeviceListQuerySchema)) q: Infer<typeof powerDeviceListQuerySchema>) {
    return this.svc.devices(p, q);
  }

  @Get('devices/:id')
  @RequirePermissions('power.read')
  device(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.device(p, id);
  }

  @Get('devices/:id/history')
  @RequirePermissions('power.read')
  @ApiZodQuery(powerHistoryQuerySchema)
  history(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Query(new ZodPipe(powerHistoryQuerySchema)) q: Infer<typeof powerHistoryQuerySchema>) {
    return this.svc.history(p, id, q.range);
  }

  @Put('devices/:id/profile')
  @StaffOnly()
  @RequirePermissions('power.configure')
  @ApiOperation({ summary: 'Admin estimate (used only when there is no fresh measurement) and inclusion in totals.' })
  @ApiZodBody(powerProfileSchema)
  setProfile(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(powerProfileSchema)) b: Infer<typeof powerProfileSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.setProfile(p, id, b, m);
  }

  @Get('racks')
  @StaffOnly()
  @RequirePermissions('power.read')
  @ApiZodQuery(dcQuery)
  racks(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(dcQuery)) q: Infer<typeof dcQuery>) {
    return this.svc.racks(p, q.datacenterId);
  }

  @Get('pdus')
  @StaffOnly()
  @RequirePermissions('power.read')
  pdus(@CurrentPrincipal() p: Principal) {
    return this.svc.pdus(p);
  }

  @Put('outlets/:id')
  @StaffOnly()
  @RequirePermissions('power.configure')
  @ApiOperation({ summary: 'Record which device a PDU outlet feeds. A device fed by outlets gets a PDU-measured reading when all of its outlets report.' })
  @ApiZodBody(outletMappingSchema)
  mapOutlet(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(outletMappingSchema)) b: Infer<typeof outletMappingSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.mapOutlet(p, id, b, m);
  }

  @Get('polling')
  @StaffOnly()
  @RequirePermissions('power.read')
  polling(@CurrentPrincipal() p: Principal) {
    return this.svc.polling(p);
  }

  @Put('polling/:deviceId')
  @StaffOnly()
  @RequirePermissions('power.configure')
  @ApiZodBody(powerPollingSchema)
  configurePolling(@CurrentPrincipal() p: Principal, @Param('deviceId', UUID) id: string, @Body(new ZodPipe(powerPollingSchema)) b: Infer<typeof powerPollingSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.configurePolling(p, id, b, m);
  }

  @Delete('polling/:deviceId')
  @StaffOnly()
  @RequirePermissions('power.configure')
  removePolling(@CurrentPrincipal() p: Principal, @Param('deviceId', UUID) id: string, @ReqMeta() m: RequestMeta) {
    return this.svc.removePolling(p, id, m);
  }

  @Get('tariffs')
  @StaffOnly()
  @RequirePermissions('power.read')
  tariffs(@CurrentPrincipal() p: Principal) {
    return this.svc.tariffs(p);
  }

  @Post('tariffs')
  @StaffOnly()
  @RequirePermissions('power.configure')
  @ApiZodBody(tariffSchema)
  createTariff(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(tariffSchema)) b: Infer<typeof tariffSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.createTariff(p, b, m);
  }

  @Put('tariffs/:id')
  @StaffOnly()
  @RequirePermissions('power.configure')
  @ApiZodBody(tariffSchema)
  updateTariff(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(tariffSchema)) b: Infer<typeof tariffSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.updateTariff(p, id, b, m);
  }

  @Delete('tariffs/:id')
  @StaffOnly()
  @RequirePermissions('power.configure')
  deleteTariff(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    return this.svc.deleteTariff(p, id, m);
  }

  @Get('settings')
  @StaffOnly()
  @RequirePermissions('power.read')
  settings(@CurrentPrincipal() p: Principal) {
    return this.svc.settings(p);
  }

  @Put('settings')
  @StaffOnly()
  @RequirePermissions('power.configure')
  @ApiZodBody(powerSettingsSchema)
  updateSettings(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(powerSettingsSchema)) b: Infer<typeof powerSettingsSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.updateSettings(p, b, m);
  }

  @Get('energy')
  @RequirePermissions('power.read')
  @ApiOperation({ summary: 'Energy grouped by device, rack, datacenter, customer or category (customers: device or category).' })
  @ApiZodQuery(powerExportQuerySchema)
  energy(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(powerExportQuerySchema)) q: Infer<typeof powerExportQuerySchema>) {
    return this.svc.energyReport(p, q);
  }

  @Get('energy.csv')
  @RequirePermissions('power.read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="energy.csv"')
  @ApiOperation({ summary: 'Energy per device, rack, datacenter, customer or category for a period; measured, estimated and unknown in separate columns; cost for staff.' })
  @ApiZodQuery(powerExportQuerySchema)
  exportCsv(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(powerExportQuerySchema)) q: Infer<typeof powerExportQuerySchema>) {
    return this.svc.exportCsv(p, q);
  }
}
