import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import {
  allocationEndSchema,
  allocationSchema,
  allocationUpdateSchema,
  coloListQuerySchema,
  crossConnectSchema,
  crossConnectStatusSchema,
  serviceListQuerySchema,
  serviceSchema,
  serviceStatusSchema,
  shipmentSchema,
  shipmentStatusSchema,
  ticketListQuerySchema,
  ticketMessageSchema,
  ticketSchema,
  ticketTimeSchema,
  ticketUpdateSchema,
  visitSchema,
  visitStatusSchema,
} from '@crapplet/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions, StaffOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { ColocationService } from './colocation.service';
import { ServicesService } from './services.service';
import { TicketsService } from './tickets.service';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;
const UUID = new ParseUUIDPipe();

/**
 * Colocation. Reads need `services.read` (customers: their own). Allocations
 * are managed by staff with `services.write`. Cross-connect, shipment and visit
 * requests are filed by staff (`services.write`) or by customer users with
 * `tickets.write` for their own account; status changes are staff work, except
 * that a customer can withdraw or cancel its own request.
 */
@ApiTags('colocation')
@ApiCookieAuth()
@Controller({ path: 'colocation', version: '1' })
export class ColocationController {
  constructor(private readonly svc: ColocationService) {}

  @Get('overview')
  @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Space, contracted vs. used power (measured and estimated apart), bandwidth now and open requests.' })
  overview(@CurrentPrincipal() p: Principal) {
    return this.svc.overview(p);
  }

  @Get('sites')
  @RequirePermissions('services.read')
  sites(@CurrentPrincipal() p: Principal) {
    return this.svc.sites(p);
  }

  @Get('allocations')
  @RequirePermissions('services.read')
  @ApiZodQuery(coloListQuerySchema)
  allocations(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(coloListQuerySchema)) q: Infer<typeof coloListQuerySchema>) {
    return this.svc.allocations(p, q);
  }

  @Get('allocations/:id')
  @RequirePermissions('services.read')
  allocation(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.allocation(p, id);
  }

  @Post('allocations')
  @RequirePermissions('services.write')
  @StaffOnly()
  @ApiOperation({ summary: 'Allocate rack space (full, half, quarter or custom units) with contracted power. Holds the units with a rack reservation.' })
  @ApiZodBody(allocationSchema)
  createAllocation(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(allocationSchema)) b: Infer<typeof allocationSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.createAllocation(p, b, meta);
  }

  @Put('allocations/:id')
  @RequirePermissions('services.write')
  @StaffOnly()
  @ApiZodBody(allocationUpdateSchema)
  updateAllocation(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(allocationUpdateSchema)) b: Infer<typeof allocationUpdateSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.updateAllocation(p, id, b, meta);
  }

  @Post('allocations/:id/end')
  @HttpCode(200)
  @RequirePermissions('services.write')
  @StaffOnly()
  @ApiZodBody(allocationEndSchema)
  endAllocation(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(allocationEndSchema)) b: Infer<typeof allocationEndSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.endAllocation(p, id, b, meta);
  }

  @Get('cross-connects')
  @RequirePermissions('services.read')
  @ApiZodQuery(coloListQuerySchema)
  crossConnects(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(coloListQuerySchema)) q: Infer<typeof coloListQuerySchema>) {
    return this.svc.crossConnects(p, q);
  }

  @Post('cross-connects')
  @RequirePermissions('services.read')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiZodBody(crossConnectSchema)
  createCrossConnect(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(crossConnectSchema)) b: Infer<typeof crossConnectSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.createCrossConnect(p, b, meta);
  }

  @Post('cross-connects/:id/status')
  @HttpCode(200)
  @RequirePermissions('services.read')
  @ApiZodBody(crossConnectStatusSchema)
  crossConnectStatus(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(crossConnectStatusSchema)) b: Infer<typeof crossConnectStatusSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.crossConnectStatus(p, id, b, meta);
  }

  @Get('shipments')
  @RequirePermissions('services.read')
  @ApiZodQuery(coloListQuerySchema)
  shipments(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(coloListQuerySchema)) q: Infer<typeof coloListQuerySchema>) {
    return this.svc.shipments(p, q);
  }

  @Post('shipments')
  @RequirePermissions('services.read')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiZodBody(shipmentSchema)
  createShipment(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(shipmentSchema)) b: Infer<typeof shipmentSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.createShipment(p, b, meta);
  }

  @Post('shipments/:id/status')
  @HttpCode(200)
  @RequirePermissions('services.read')
  @ApiZodBody(shipmentStatusSchema)
  shipmentStatus(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(shipmentStatusSchema)) b: Infer<typeof shipmentStatusSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.shipmentStatus(p, id, b, meta);
  }

  @Get('visits')
  @RequirePermissions('services.read')
  @ApiZodQuery(coloListQuerySchema)
  visits(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(coloListQuerySchema)) q: Infer<typeof coloListQuerySchema>) {
    return this.svc.visits(p, q);
  }

  @Post('visits')
  @RequirePermissions('services.read')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiZodBody(visitSchema)
  createVisit(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(visitSchema)) b: Infer<typeof visitSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.createVisit(p, b, meta);
  }

  @Post('visits/:id/status')
  @HttpCode(200)
  @RequirePermissions('services.read')
  @ApiZodBody(visitStatusSchema)
  visitStatus(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(visitStatusSchema)) b: Infer<typeof visitStatusSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.visitStatus(p, id, b, meta);
  }
}

/** Orders & Services. Reads: `services.read` (customers: their own, without staff notes). Changes: staff with `services.write`. */
@ApiTags('services')
@ApiCookieAuth()
@Controller({ path: 'services', version: '1' })
export class ServicesController {
  constructor(private readonly svc: ServicesService) {}

  @Get()
  @RequirePermissions('services.read')
  @ApiZodQuery(serviceListQuerySchema)
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(serviceListQuerySchema)) q: Infer<typeof serviceListQuerySchema>) {
    return this.svc.list(p, q);
  }

  @Get(':id')
  @RequirePermissions('services.read')
  get(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.get(p, id);
  }

  @Post()
  @RequirePermissions('services.write')
  @StaffOnly()
  @ApiZodBody(serviceSchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(serviceSchema)) b: Infer<typeof serviceSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.create(p, b, meta);
  }

  @Put(':id')
  @RequirePermissions('services.write')
  @StaffOnly()
  @ApiZodBody(serviceSchema)
  update(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(serviceSchema)) b: Infer<typeof serviceSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.update(p, id, b, meta);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermissions('services.write')
  @StaffOnly()
  @ApiOperation({ summary: 'Move a service through pending → active ⇄ suspended → terminated (or pending → cancelled). Records only; nothing is switched off.' })
  @ApiZodBody(serviceStatusSchema)
  status(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(serviceStatusSchema)) b: Infer<typeof serviceStatusSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.setStatus(p, id, b, meta);
  }
}

/** Remote hands and support tickets. Reads: `tickets.read`; writes: `tickets.write`. Internal notes and time logging are staff-only. */
@ApiTags('tickets')
@ApiCookieAuth()
@Controller({ path: 'tickets', version: '1' })
export class TicketsController {
  constructor(private readonly svc: TicketsService) {}

  @Get()
  @RequirePermissions('tickets.read')
  @ApiZodQuery(ticketListQuerySchema)
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(ticketListQuerySchema)) q: Infer<typeof ticketListQuerySchema>) {
    return this.svc.list(p, q);
  }

  @Get('assignees')
  @RequirePermissions('tickets.read')
  @StaffOnly()
  assignees(@CurrentPrincipal() p: Principal) {
    return this.svc.assignees(p);
  }

  @Get(':id')
  @RequirePermissions('tickets.read')
  get(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.get(p, id);
  }

  @Post()
  @RequirePermissions('tickets.write')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiZodBody(ticketSchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(ticketSchema)) b: Infer<typeof ticketSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.create(p, b, meta);
  }

  @Post(':id/messages')
  @RequirePermissions('tickets.write')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @ApiZodBody(ticketMessageSchema)
  reply(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(ticketMessageSchema)) b: Infer<typeof ticketMessageSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.reply(p, id, b, meta);
  }

  @Patch(':id')
  @RequirePermissions('tickets.write')
  @ApiZodBody(ticketUpdateSchema)
  update(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(ticketUpdateSchema)) b: Infer<typeof ticketUpdateSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.update(p, id, b, meta);
  }

  @Post(':id/time')
  @RequirePermissions('tickets.write')
  @StaffOnly()
  @ApiZodBody(ticketTimeSchema)
  time(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(ticketTimeSchema)) b: Infer<typeof ticketTimeSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.logTime(p, id, b, meta);
  }
}
