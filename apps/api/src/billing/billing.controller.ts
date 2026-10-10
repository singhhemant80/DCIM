import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { billingIntegrationSchema, productMappingSchema, reconcileSchema, usageQuerySchema } from '@crapplet/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, Public, ReqMeta, RequirePermissions, SessionOnly, StaffOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { BillingService } from './billing.service';
import { systemPrincipal } from './system-principal';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;
const UUID = new ParseUUIDPipe();
const eventsQuery = z.object({ status: z.enum(['applied', 'ignored', 'rejected', 'review']).optional() });
type RawRequest = Request & { rawBody?: Buffer };
const MODULE_THROTTLE = { default: { ttl: 60_000, limit: 300 } };

/** Billing integrations (WHMCS). Staff with `billing.manage`. */
@ApiTags('billing')
@ApiCookieAuth()
@ApiBearerAuth()
@StaffOnly()
@Controller({ path: 'billing', version: '1' })
export class BillingController {
  constructor(private readonly svc: BillingService) {}

  @Get('integrations')
  @RequirePermissions('billing.manage')
  list(@CurrentPrincipal() p: Principal) {
    return this.svc.list(p);
  }

  @Post('integrations')
  @SessionOnly()
  @RequirePermissions('billing.manage')
  @ApiOperation({ summary: 'Add a WHMCS integration. The shared secret for the module is returned once.' })
  @ApiZodBody(billingIntegrationSchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(billingIntegrationSchema)) b: Infer<typeof billingIntegrationSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.create(p, b, meta);
  }

  @Put('integrations/:id')
  @RequirePermissions('billing.manage')
  @ApiZodBody(billingIntegrationSchema)
  update(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(billingIntegrationSchema)) b: Infer<typeof billingIntegrationSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.update(p, id, b, meta);
  }

  @Post('integrations/:id/rotate-secret')
  @HttpCode(200)
  @SessionOnly()
  @RequirePermissions('billing.manage')
  rotate(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.rotateSecret(p, id, meta);
  }

  @Get('integrations/:id/mappings')
  @RequirePermissions('billing.manage')
  mappings(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.mappings(p, id);
  }

  @Put('integrations/:id/mappings')
  @RequirePermissions('billing.manage')
  @ApiOperation({ summary: 'Map a WHMCS product id to a service kind (used when services are created from WHMCS).' })
  @ApiZodBody(productMappingSchema)
  putMapping(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(productMappingSchema)) b: Infer<typeof productMappingSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.putMapping(p, id, b, meta);
  }

  @Delete('integrations/:id/mappings/:mappingId')
  @RequirePermissions('billing.manage')
  deleteMapping(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Param('mappingId', UUID) mappingId: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.deleteMapping(p, id, mappingId, meta);
  }

  @Get('integrations/:id/events')
  @RequirePermissions('billing.manage')
  @ApiZodQuery(eventsQuery)
  events(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Query(new ZodPipe(eventsQuery)) q: Infer<typeof eventsQuery>) {
    return this.svc.events(p, id, q.status);
  }

  @Get('integrations/:id/reconciliations')
  @RequirePermissions('billing.manage')
  reconciliations(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.reconciliations(p, id);
  }

  @Post('integrations/:id/reconcile')
  @HttpCode(200)
  @RequirePermissions('billing.manage')
  @ApiOperation({ summary: 'Compare a WHMCS service export with NexoraDC services. Report only: nothing is changed.' })
  @ApiZodBody(reconcileSchema)
  reconcile(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(reconcileSchema)) b: Infer<typeof reconcileSchema>) {
    return this.svc.reconcileByStaff(p, id, b);
  }

  @Get('usage')
  @RequirePermissions('billing.manage')
  @ApiOperation({ summary: 'Energy (measured and estimated apart) and 95th-percentile bandwidth for a service, by billing reference.' })
  @ApiZodQuery(usageQuerySchema)
  usage(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(usageQuerySchema)) q: Infer<typeof usageQuerySchema>) {
    return this.svc.usage(p, q);
  }
}

/**
 * Endpoints the NexoraDC WHMCS module calls. No session or API key: each call
 * is signed with the integration's shared secret (HMAC-SHA256 over
 * "<timestamp>.<raw body>", in X-NexoraDC-Timestamp / X-NexoraDC-Signature).
 */
@ApiTags('billing')
@Controller({ path: 'billing/whmcs/:integrationId', version: '1' })
export class WhmcsModuleController {
  constructor(private readonly svc: BillingService) {}

  @Public()
  @Throttle(MODULE_THROTTLE)
  @Post('events')
  @HttpCode(200)
  @ApiOperation({ summary: 'Receive one signed WHMCS event. Idempotent per event id: a repeat returns {duplicate: true} and changes nothing.' })
  async events(@Param('integrationId') id: string, @Req() req: RawRequest, @Body() body: unknown) {
    const i = await this.svc.verify(id, req.headers, req.rawBody);
    return this.svc.receive(i, body);
  }

  @Public()
  @Throttle(MODULE_THROTTLE)
  @Post('ping')
  @HttpCode(200)
  @ApiOperation({ summary: 'Signed connection test (changes nothing).' })
  async ping(@Param('integrationId') id: string, @Req() req: RawRequest) {
    return this.svc.ping(await this.svc.verify(id, req.headers, req.rawBody));
  }

  @Public()
  @Throttle(MODULE_THROTTLE)
  @Post('reconcile')
  @HttpCode(200)
  @ApiOperation({ summary: 'Signed WHMCS service snapshot for reconciliation (report only).' })
  async reconcile(@Param('integrationId') id: string, @Req() req: RawRequest, @Body() body: unknown) {
    const i = await this.svc.verify(id, req.headers, req.rawBody);
    return this.svc.reconcile(i, new ZodPipe(reconcileSchema).transform(body) as Infer<typeof reconcileSchema>, 'whmcs module');
  }

  @Public()
  @Throttle(MODULE_THROTTLE)
  @Post('usage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Signed usage query from the module (same result as GET /billing/usage).' })
  async usage(@Param('integrationId') id: string, @Req() req: RawRequest, @Body() body: unknown) {
    const i = await this.svc.verify(id, req.headers, req.rawBody);
    return this.svc.usage(systemPrincipal(i.orgId, `billing integration ${i.name}`), new ZodPipe(usageQuerySchema).transform(body) as Infer<typeof usageQuerySchema>);
  }
}
