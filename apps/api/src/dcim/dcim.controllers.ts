import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  buildingSchema,
  bulkDeviceSchema,
  datacenterSchema,
  deviceCreateSchema,
  deviceEventSchema,
  deviceImportSchema,
  deviceListQuerySchema,
  deviceModelSchema,
  deviceSchema,
  lifecycleRulesSchema,
  manufacturerSchema,
  placementSchema,
  rackMoveSchema,
  rackSchema,
  reservationSchema,
  roomSchema,
  rowSchema,
  sparePartAdjustSchema,
  sparePartSchema,
  transitionSchema,
  type DeviceCreateInput,
  type DeviceInput,
} from '@crapplet/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions, StaffOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { SitesService } from './sites.service';
import { RacksService } from './racks.service';
import { ModelsService } from './models.service';
import { DevicesService } from './devices.service';
import { SparesService } from './spares.service';
import { DcimSummaryService } from './summary.service';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;
const UUID = new ParseUUIDPipe();

const rackListQuery = z.object({ datacenterId: z.string().uuid().optional(), roomId: z.string().uuid().optional(), q: z.string().trim().max(100).optional() });
const sparesQuery = z.object({ kind: z.string().max(20).optional(), datacenterId: z.string().uuid().optional(), lowStock: z.enum(['true', 'false']).optional(), q: z.string().trim().max(100).optional() });
const exportQuery = deviceListQuerySchema.omit({ page: true, pageSize: true });

/* ---------------------------------------------------------------- sites */

@ApiTags('dcim: sites')
@ApiCookieAuth()
@StaffOnly()
@Controller({ path: 'dcim', version: '1' })
export class SitesController {
  constructor(
    private readonly sites: SitesService,
    private readonly summary: DcimSummaryService,
  ) {}

  @Get('summary')
  @RequirePermissions('dcim.read')
  @ApiOperation({ summary: 'Physical inventory figures for the dashboard.' })
  getSummary(@CurrentPrincipal() p: Principal) {
    return this.summary.summary(p);
  }

  @Get('tree')
  @RequirePermissions('dcim.read')
  @ApiOperation({ summary: 'Datacenter → building → room → row hierarchy.' })
  tree(@CurrentPrincipal() p: Principal) {
    return this.sites.tree(p);
  }

  @Get('datacenters')
  @RequirePermissions('dcim.read')
  listDatacenters(@CurrentPrincipal() p: Principal) {
    return this.sites.listDatacenters(p);
  }

  @Get('datacenters/:id')
  @RequirePermissions('dcim.read')
  getDatacenter(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.sites.getDatacenter(p, id);
  }

  @Post('datacenters')
  @RequirePermissions('dcim.write')
  @ApiZodBody(datacenterSchema)
  createDatacenter(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(datacenterSchema)) b: Infer<typeof datacenterSchema>, @ReqMeta() m: RequestMeta) {
    return this.sites.createDatacenter(p, b, m);
  }

  @Patch('datacenters/:id')
  @RequirePermissions('dcim.write')
  @ApiZodBody(datacenterSchema)
  updateDatacenter(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(datacenterSchema)) b: Infer<typeof datacenterSchema>, @ReqMeta() m: RequestMeta) {
    return this.sites.updateDatacenter(p, id, b, m);
  }

  @Delete('datacenters/:id')
  @HttpCode(204)
  @RequirePermissions('dcim.write')
  async deleteDatacenter(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.sites.deleteDatacenter(p, id, m);
  }

  @Post('buildings')
  @RequirePermissions('dcim.write')
  @ApiZodBody(buildingSchema)
  createBuilding(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(buildingSchema)) b: Infer<typeof buildingSchema>, @ReqMeta() m: RequestMeta) {
    return this.sites.createBuilding(p, b, m);
  }

  @Patch('buildings/:id')
  @RequirePermissions('dcim.write')
  @ApiZodBody(buildingSchema)
  updateBuilding(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(buildingSchema)) b: Infer<typeof buildingSchema>, @ReqMeta() m: RequestMeta) {
    return this.sites.updateBuilding(p, id, b, m);
  }

  @Delete('buildings/:id')
  @HttpCode(204)
  @RequirePermissions('dcim.write')
  async deleteBuilding(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.sites.deleteBuilding(p, id, m);
  }

  @Post('rooms')
  @RequirePermissions('dcim.write')
  @ApiZodBody(roomSchema)
  createRoom(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(roomSchema)) b: Infer<typeof roomSchema>, @ReqMeta() m: RequestMeta) {
    return this.sites.createRoom(p, b, m);
  }

  @Patch('rooms/:id')
  @RequirePermissions('dcim.write')
  @ApiZodBody(roomSchema)
  updateRoom(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(roomSchema)) b: Infer<typeof roomSchema>, @ReqMeta() m: RequestMeta) {
    return this.sites.updateRoom(p, id, b, m);
  }

  @Delete('rooms/:id')
  @HttpCode(204)
  @RequirePermissions('dcim.write')
  async deleteRoom(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.sites.deleteRoom(p, id, m);
  }

  @Post('rows')
  @RequirePermissions('dcim.write')
  @ApiZodBody(rowSchema)
  createRow(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(rowSchema)) b: Infer<typeof rowSchema>, @ReqMeta() m: RequestMeta) {
    return this.sites.createRow(p, b, m);
  }

  @Patch('rows/:id')
  @RequirePermissions('dcim.write')
  @ApiZodBody(rowSchema)
  updateRow(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(rowSchema)) b: Infer<typeof rowSchema>, @ReqMeta() m: RequestMeta) {
    return this.sites.updateRow(p, id, b, m);
  }

  @Delete('rows/:id')
  @HttpCode(204)
  @RequirePermissions('dcim.write')
  async deleteRow(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.sites.deleteRow(p, id, m);
  }

  @Get('lifecycle-rules')
  @RequirePermissions('dcim.read')
  lifecycleRules(@CurrentPrincipal() p: Principal) {
    return this.summary.lifecycleRules(p);
  }

  @Put('lifecycle-rules')
  @RequirePermissions('settings.write')
  @ApiZodBody(lifecycleRulesSchema)
  @ApiOperation({ summary: 'Replace the allowed device lifecycle transitions.' })
  setLifecycleRules(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(lifecycleRulesSchema)) b: Infer<typeof lifecycleRulesSchema>, @ReqMeta() m: RequestMeta) {
    return this.summary.setLifecycleRules(p, b.transitions, m);
  }
}

/* ---------------------------------------------------------------- racks */

@ApiTags('dcim: racks')
@ApiCookieAuth()
@StaffOnly()
@Controller({ path: 'dcim/racks', version: '1' })
export class RacksController {
  constructor(private readonly racks: RacksService) {}

  @Get()
  @RequirePermissions('dcim.read')
  @ApiZodQuery(rackListQuery)
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(rackListQuery)) q: Infer<typeof rackListQuery>) {
    return this.racks.list(p, q);
  }

  @Get(':id/elevation')
  @RequirePermissions('dcim.read')
  @ApiOperation({ summary: 'Rack with placed devices, 0U devices and reservations, for the elevation view.' })
  elevation(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.racks.elevation(p, id);
  }

  @Get(':id/events')
  @RequirePermissions('dcim.read')
  events(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.racks.events(p, id);
  }

  @Post()
  @RequirePermissions('dcim.write')
  @ApiZodBody(rackSchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(rackSchema)) b: Infer<typeof rackSchema>, @ReqMeta() m: RequestMeta) {
    return this.racks.create(p, b, m);
  }

  @Patch(':id')
  @RequirePermissions('dcim.write')
  @ApiZodBody(rackSchema)
  update(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(rackSchema)) b: Infer<typeof rackSchema>, @ReqMeta() m: RequestMeta) {
    return this.racks.update(p, id, b, m);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('dcim.write')
  async remove(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.racks.remove(p, id, m);
  }

  @Post(':id/move')
  @HttpCode(200)
  @RequirePermissions('dcim.write')
  @ApiZodBody(rackMoveSchema)
  @ApiOperation({ summary: 'Relocate a rack (with its equipment) to another room, row or floor position.' })
  move(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(rackMoveSchema)) b: Infer<typeof rackMoveSchema>, @ReqMeta() m: RequestMeta) {
    return this.racks.move(p, id, b, m);
  }

  @Post(':id/reservations')
  @RequirePermissions('dcim.write')
  @ApiZodBody(reservationSchema)
  reserve(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(reservationSchema)) b: Infer<typeof reservationSchema>, @ReqMeta() m: RequestMeta) {
    return this.racks.addReservation(p, id, b, m);
  }

  @Delete(':id/reservations/:reservationId')
  @HttpCode(204)
  @RequirePermissions('dcim.write')
  async unreserve(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Param('reservationId', UUID) rid: string, @ReqMeta() m: RequestMeta) {
    await this.racks.removeReservation(p, id, rid, m);
  }
}

/* ---------------------------------------------------------------- models */

@ApiTags('dcim: models')
@ApiCookieAuth()
@StaffOnly()
@Controller({ path: 'dcim', version: '1' })
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get('manufacturers')
  @RequirePermissions('dcim.read')
  listManufacturers(@CurrentPrincipal() p: Principal) {
    return this.models.listManufacturers(p);
  }

  @Post('manufacturers')
  @RequirePermissions('dcim.write')
  @ApiZodBody(manufacturerSchema)
  createManufacturer(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(manufacturerSchema)) b: Infer<typeof manufacturerSchema>, @ReqMeta() m: RequestMeta) {
    return this.models.createManufacturer(p, b, m);
  }

  @Get('models')
  @RequirePermissions('dcim.read')
  listModels(@CurrentPrincipal() p: Principal) {
    return this.models.listModels(p);
  }

  @Post('models')
  @RequirePermissions('dcim.write')
  @ApiZodBody(deviceModelSchema)
  createModel(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(deviceModelSchema)) b: Infer<typeof deviceModelSchema>, @ReqMeta() m: RequestMeta) {
    return this.models.createModel(p, b, m);
  }

  @Patch('models/:id')
  @RequirePermissions('dcim.write')
  @ApiZodBody(deviceModelSchema)
  updateModel(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(deviceModelSchema)) b: Infer<typeof deviceModelSchema>, @ReqMeta() m: RequestMeta) {
    return this.models.updateModel(p, id, b, m);
  }

  @Delete('models/:id')
  @HttpCode(204)
  @RequirePermissions('dcim.write')
  async deleteModel(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.models.deleteModel(p, id, m);
  }
}

/* ---------------------------------------------------------------- devices */

@ApiTags('dcim: devices')
@ApiCookieAuth()
@Controller({ path: 'dcim/devices', version: '1' })
export class DevicesController {
  constructor(private readonly devicesSvc: DevicesService) {}

  @Get()
  @RequirePermissions('dcim.read')
  @ApiZodQuery(deviceListQuerySchema)
  @ApiOperation({ summary: 'Devices. Customer users only receive their own equipment.' })
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(deviceListQuerySchema)) q: Infer<typeof deviceListQuerySchema>) {
    return this.devicesSvc.list(p, q);
  }

  @Get('export.csv')
  @StaffOnly()
  @RequirePermissions('dcim.read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="devices.csv"')
  @ApiZodQuery(exportQuery)
  exportCsv(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(exportQuery)) q: Infer<typeof exportQuery>) {
    return this.devicesSvc.exportCsv(p, q);
  }

  @Post('import')
  @HttpCode(200)
  @StaffOnly()
  @RequirePermissions('dcim.write')
  @ApiZodBody(deviceImportSchema)
  @ApiOperation({ summary: 'Import devices from CSV. dryRun validates against the database and rolls back.' })
  importCsv(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(deviceImportSchema)) b: Infer<typeof deviceImportSchema>, @ReqMeta() m: RequestMeta) {
    return this.devicesSvc.importCsv(p, b.csv, b.dryRun, m);
  }

  @Post('bulk')
  @HttpCode(200)
  @StaffOnly()
  @RequirePermissions('dcim.write')
  @ApiZodBody(bulkDeviceSchema)
  bulk(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(bulkDeviceSchema)) b: Infer<typeof bulkDeviceSchema>, @ReqMeta() m: RequestMeta) {
    return this.devicesSvc.bulk(p, b, m);
  }

  @Get(':id')
  @RequirePermissions('dcim.read')
  get(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.devicesSvc.get(p, id);
  }

  @Get(':id/transitions')
  @StaffOnly()
  @RequirePermissions('dcim.read')
  @ApiOperation({ summary: 'States this device may move to next under the organization’s rules.' })
  async transitions(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    const d = await this.devicesSvc.get(p, id);
    return this.devicesSvc.allowedTransitions(p, d.lifecycleState);
  }

  @Get(':id/events')
  @StaffOnly()
  @RequirePermissions('dcim.read')
  events(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.devicesSvc.events(p, id);
  }

  @Get(':id/label')
  @StaffOnly()
  @RequirePermissions('dcim.read')
  label(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.devicesSvc.label(p, id);
  }

  @Post()
  @StaffOnly()
  @RequirePermissions('dcim.write')
  @ApiZodBody(deviceCreateSchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(deviceCreateSchema)) b: DeviceCreateInput, @ReqMeta() m: RequestMeta) {
    return this.devicesSvc.create(p, b, m);
  }

  @Patch(':id')
  @StaffOnly()
  @RequirePermissions('dcim.write')
  @ApiZodBody(deviceSchema)
  update(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(deviceSchema)) b: DeviceInput, @ReqMeta() m: RequestMeta) {
    return this.devicesSvc.update(p, id, b, m);
  }

  @Post(':id/placement')
  @HttpCode(200)
  @StaffOnly()
  @RequirePermissions('dcim.write')
  @ApiZodBody(placementSchema)
  @ApiOperation({ summary: 'Place in a rack (rackId, positionU, face) or take out (rackId: null).' })
  place(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(placementSchema)) b: Infer<typeof placementSchema>, @ReqMeta() m: RequestMeta) {
    return this.devicesSvc.place(p, id, b, m);
  }

  @Post(':id/transition')
  @HttpCode(200)
  @StaffOnly()
  @RequirePermissions('dcim.write')
  @ApiZodBody(transitionSchema)
  transition(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(transitionSchema)) b: Infer<typeof transitionSchema>, @ReqMeta() m: RequestMeta) {
    return this.devicesSvc.transition(p, id, b.to, b.note, m);
  }

  @Post(':id/events')
  @StaffOnly()
  @RequirePermissions('dcim.write')
  @ApiZodBody(deviceEventSchema)
  addEvent(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(deviceEventSchema)) b: Infer<typeof deviceEventSchema>, @ReqMeta() m: RequestMeta) {
    return this.devicesSvc.addEvent(p, id, b, m);
  }
}

/* ---------------------------------------------------------------- spares */

@ApiTags('dcim: spare parts')
@ApiCookieAuth()
@StaffOnly()
@Controller({ path: 'dcim/spare-parts', version: '1' })
export class SparesController {
  constructor(private readonly spares: SparesService) {}

  @Get()
  @RequirePermissions('dcim.read')
  @ApiZodQuery(sparesQuery)
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(sparesQuery)) q: Infer<typeof sparesQuery>) {
    return this.spares.list(p, q);
  }

  @Post()
  @RequirePermissions('dcim.write')
  @ApiZodBody(sparePartSchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(sparePartSchema)) b: Infer<typeof sparePartSchema>, @ReqMeta() m: RequestMeta) {
    return this.spares.create(p, b, m);
  }

  @Patch(':id')
  @RequirePermissions('dcim.write')
  @ApiZodBody(sparePartSchema)
  update(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(sparePartSchema)) b: Infer<typeof sparePartSchema>, @ReqMeta() m: RequestMeta) {
    return this.spares.update(p, id, b, m);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('dcim.write')
  async remove(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    await this.spares.remove(p, id, m);
  }

  @Post(':id/adjust')
  @HttpCode(200)
  @RequirePermissions('dcim.write')
  @ApiZodBody(sparePartAdjustSchema)
  adjust(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(sparePartAdjustSchema)) b: Infer<typeof sparePartAdjustSchema>, @ReqMeta() m: RequestMeta) {
    return this.spares.adjust(p, id, b, m);
  }

  @Get(':id/movements')
  @RequirePermissions('dcim.read')
  movements(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.spares.movements(p, id);
  }
}
