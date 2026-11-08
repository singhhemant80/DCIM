import { Body, Controller, Get, Headers, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  addFundsSchema,
  billingSettingsSchema,
  clientPriceSchema,
  customerBillingSchema,
  subscriptionActionSchema,
  subscriptionCancelSchema,
  subscriptionUpdateSchema,
  SUBSCRIPTION_STATUSES,
  vpsOrderSchema,
  vpsPlanSchema,
  walletAdjustSchema,
} from '@crapplet/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { CommerceService } from './commerce.service';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;
const UUID = new ParseUUIDPipe();
const IDEM = 'idempotency-key';
const customerQuery = z.object({ customerId: z.string().uuid().optional() });
const subsQuery = customerQuery.extend({ status: z.enum(SUBSCRIPTION_STATUSES).optional() });
const resolveSchema = z.object({ action: z.enum(['refund', 'delivered']), guestId: z.string().uuid().optional(), reason: z.string().trim().max(400).optional() });

/**
 * Native billing: plans, client prices, wallets, VPS orders, renewals and
 * GST invoices. Staff need billing.read / billing.write (checked in the
 * service); client users see their own account and order with orders.place.
 */
@ApiTags('invoicing')
@ApiCookieAuth()
@ApiBearerAuth()
@Controller({ path: 'invoicing', version: '1' })
export class CommerceController {
  constructor(private readonly svc: CommerceService) {}

  @Get('summary')
  @RequirePermissions('billing.read')
  summary(@CurrentPrincipal() p: Principal) {
    return this.svc.summary(p);
  }

  @Get('settings')
  @RequirePermissions('billing.read')
  settings(@CurrentPrincipal() p: Principal) {
    return this.svc.getSettings(p);
  }

  @Put('settings')
  @RequirePermissions('billing.write')
  @ApiOperation({ summary: 'Supplier details for GST invoices (legal name, address, state, GSTIN), GST rate, SAC, number prefixes and grace days.' })
  @ApiZodBody(billingSettingsSchema)
  putSettings(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(billingSettingsSchema)) b: Infer<typeof billingSettingsSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.putSettings(p, b, meta);
  }

  @Get('hypervisor-plans')
  @RequirePermissions('billing.read')
  @ApiOperation({ summary: 'Plans and OS templates read from Virtualizor by the last sync.' })
  hypervisorPlans(@CurrentPrincipal() p: Principal) {
    return this.svc.hypervisorPlans(p);
  }

  @Get('plans')
  @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Plans on sale. Client users get their own price and the price with GST.' })
  plans(@CurrentPrincipal() p: Principal) {
    return this.svc.plans(p);
  }

  @Post('plans')
  @RequirePermissions('billing.write')
  @ApiZodBody(vpsPlanSchema)
  createPlan(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(vpsPlanSchema)) b: Infer<typeof vpsPlanSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.createPlan(p, b, meta);
  }

  @Put('plans/:id')
  @RequirePermissions('billing.write')
  @ApiZodBody(vpsPlanSchema)
  updatePlan(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(vpsPlanSchema)) b: Infer<typeof vpsPlanSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.updatePlan(p, id, b, meta);
  }

  @Get('plans/:id/templates')
  @RequirePermissions('services.read')
  templates(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.planTemplates(p, id);
  }

  @Get('wallets')
  @RequirePermissions('billing.read')
  wallets(@CurrentPrincipal() p: Principal) {
    return this.svc.wallets(p);
  }

  @Get('account')
  @RequirePermissions('services.read')
  @ApiOperation({ summary: "A client's balance, VPS subscriptions, wallet ledger, invoices and orders (client users: their own)." })
  @ApiZodQuery(customerQuery)
  account(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(customerQuery)) q: Infer<typeof customerQuery>) {
    return this.svc.account(p, q.customerId);
  }

  @Put('customers/:id/profile')
  @RequirePermissions('services.read')
  @ApiOperation({ summary: 'GST billing profile of a client (legal name, GSTIN, address, state). Staff with billing.write, or the client with orders.place.' })
  @ApiZodBody(customerBillingSchema)
  profile(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(customerBillingSchema)) b: Infer<typeof customerBillingSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.updateProfile(p, id, b, meta);
  }

  @Get('customers/:id/prices')
  @RequirePermissions('billing.read')
  prices(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.clientPrices(p, id);
  }

  @Put('customers/:id/prices')
  @RequirePermissions('billing.write')
  @ApiOperation({ summary: "Set (or with null, remove) a client's own monthly price for a plan." })
  @ApiZodBody(clientPriceSchema)
  setPrice(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(clientPriceSchema)) b: Infer<typeof clientPriceSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.setClientPrice(p, id, b, meta);
  }

  @Post('customers/:id/funds')
  @RequirePermissions('billing.write')
  @ApiOperation({ summary: 'Record a payment received into the wallet; returns the receipt number. Honors the Idempotency-Key header.' })
  @ApiZodBody(addFundsSchema)
  addFunds(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(addFundsSchema)) b: Infer<typeof addFundsSchema>, @Headers(IDEM) idem: string | undefined, @ReqMeta() meta: RequestMeta) {
    return this.svc.addFunds(p, id, b, idem, meta);
  }

  @Post('customers/:id/adjust')
  @RequirePermissions('billing.write')
  @ApiOperation({ summary: 'Correct a wallet balance (positive or negative) with a reason. Not a payment: no receipt.' })
  @ApiZodBody(walletAdjustSchema)
  adjust(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(walletAdjustSchema)) b: Infer<typeof walletAdjustSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.adjust(p, id, b, meta);
  }

  @Get('receipts/:id')
  @RequirePermissions('services.read')
  receipt(@CurrentPrincipal() p: Principal, @Param('id', ParseIntPipe) id: number) {
    return this.svc.receipt(p, id);
  }

  @Get('invoices')
  @RequirePermissions('services.read')
  @ApiZodQuery(customerQuery)
  invoices(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(customerQuery)) q: Infer<typeof customerQuery>) {
    return this.svc.invoices(p, q.customerId);
  }

  @Get('invoices/:id')
  @RequirePermissions('services.read')
  invoice(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.invoice(p, id);
  }

  @Get('orders')
  @RequirePermissions('services.read')
  @ApiZodQuery(customerQuery)
  orders(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(customerQuery)) q: Infer<typeof customerQuery>) {
    return this.svc.orders(p, q.customerId);
  }

  @Post('orders')
  @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Order a VPS: price + GST is taken from the wallet and Virtualizor "Create VPS" is queued. 402 when the wallet is short. Honors the Idempotency-Key header.' })
  @ApiZodBody(vpsOrderSchema)
  order(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(vpsOrderSchema)) b: Infer<typeof vpsOrderSchema>, @Headers(IDEM) idem: string | undefined, @ReqMeta() meta: RequestMeta) {
    return this.svc.placeOrder(p, b, idem, meta);
  }

  @Get('orders/:id/guests')
  @RequirePermissions('billing.read')
  guests(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.guestsFor(p, id);
  }

  @Post('orders/:id/resolve')
  @HttpCode(200)
  @RequirePermissions('billing.write')
  @ApiOperation({ summary: 'Resolve an order in review: refund it, or link the VPS that was created (invoice and subscription follow).' })
  @ApiZodBody(resolveSchema)
  resolve(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(resolveSchema)) b: Infer<typeof resolveSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.resolveOrder(p, id, b, meta);
  }

  @Get('subscriptions')
  @RequirePermissions('services.read')
  @ApiZodQuery(subsQuery)
  subscriptions(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(subsQuery)) q: Infer<typeof subsQuery>) {
    return this.svc.subscriptions(p, q.customerId, q.status);
  }

  @Post('subscriptions/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Cancel at the end of the paid period (staff, or the client for their own) or now (staff, optional GST credit note refund to the wallet); the VPS is then suspended, or deleted if asked (type the hostname).' })
  @ApiZodBody(subscriptionCancelSchema)
  cancel(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(subscriptionCancelSchema)) b: Infer<typeof subscriptionCancelSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.cancelSubscription(p, id, b, meta);
  }

  @Post('subscriptions/:id/actions')
  @HttpCode(200)
  @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Suspend or unsuspend the VPS now (staff; done by the worker within a minute), or keep a subscription that was set to cancel (staff or the client).' })
  @ApiZodBody(subscriptionActionSchema)
  action(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(subscriptionActionSchema)) b: Infer<typeof subscriptionActionSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.subscriptionAction(p, id, b, meta);
  }

  @Get('credit-notes')
  @RequirePermissions('services.read')
  @ApiZodQuery(customerQuery)
  creditNotes(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(customerQuery)) q: Infer<typeof customerQuery>) {
    return this.svc.creditNotes(p, q.customerId);
  }

  @Get('credit-notes/:id')
  @RequirePermissions('services.read')
  creditNote(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.creditNote(p, id);
  }

  @Put('subscriptions/:id')
  @RequirePermissions('billing.write')
  @ApiOperation({ summary: 'Change the monthly price or next due date, or cancel renewals (the VPS is not deleted).' })
  @ApiZodBody(subscriptionUpdateSchema)
  updateSubscription(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(subscriptionUpdateSchema)) b: Infer<typeof subscriptionUpdateSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.updateSubscription(p, id, b, meta);
  }
}
