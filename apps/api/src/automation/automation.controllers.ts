import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { EVENT_TYPES, apiKeySchema, dryRunSchema, runDecisionSchema, webhookSubscriptionSchema, workflowSchema } from '@crapplet/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions, SessionOnly, StaffOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { ApiKeysService } from './api-keys.service';
import { AutomationService } from './automation.service';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;
const UUID = new ParseUUIDPipe();
const eventQuery = z.object({ type: z.enum(EVENT_TYPES).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });
const runQuery = z.object({ workflowId: z.string().uuid().optional(), status: z.enum(['pending', 'waiting_approval', 'approved', 'completed', 'failed', 'rejected', 'skipped']).optional() });

/**
 * API keys. Managing keys needs an interactive session: a key can never
 * create, list or revoke keys.
 */
@ApiTags('api-keys')
@ApiCookieAuth()
@StaffOnly()
@SessionOnly()
@Controller({ path: 'api-keys', version: '1' })
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @RequirePermissions('apikeys.manage')
  list(@CurrentPrincipal() p: Principal) {
    return this.keys.list(p);
  }

  @Post()
  @RequirePermissions('apikeys.manage')
  @ApiOperation({ summary: 'Create a key. The token is returned once; only its hash is stored. Its scopes must be permissions you hold.' })
  @ApiZodBody(apiKeySchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(apiKeySchema)) b: Infer<typeof apiKeySchema>, @ReqMeta() meta: RequestMeta) {
    return this.keys.create(p, b, meta);
  }

  @Delete(':id')
  @RequirePermissions('apikeys.manage')
  revoke(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() meta: RequestMeta) {
    return this.keys.revoke(p, id, meta);
  }
}

/** Domain events and outbound webhook subscriptions. */
@ApiTags('webhooks')
@ApiCookieAuth()
@ApiBearerAuth()
@StaffOnly()
@Controller({ path: 'automation', version: '1' })
export class WebhooksController {
  constructor(private readonly svc: AutomationService) {}

  @Get('event-types')
  @RequirePermissions('workflows.manage')
  eventTypes() {
    return EVENT_TYPES;
  }

  @Get('events')
  @RequirePermissions('workflows.manage')
  @ApiOperation({ summary: 'Recent domain events (the source of webhooks and workflows).' })
  @ApiZodQuery(eventQuery)
  events(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(eventQuery)) q: Infer<typeof eventQuery>) {
    return this.svc.events(p, q);
  }

  @Get('webhooks')
  @RequirePermissions('workflows.manage')
  subscriptions(@CurrentPrincipal() p: Principal) {
    return this.svc.subscriptions(p);
  }

  @Post('webhooks')
  @SessionOnly()
  @RequirePermissions('workflows.manage')
  @ApiOperation({ summary: 'Subscribe a URL to events. The signing secret is returned once.' })
  @ApiZodBody(webhookSubscriptionSchema)
  createSubscription(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(webhookSubscriptionSchema)) b: Infer<typeof webhookSubscriptionSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.createSubscription(p, b, meta);
  }

  @Put('webhooks/:id')
  @RequirePermissions('workflows.manage')
  @ApiZodBody(webhookSubscriptionSchema)
  updateSubscription(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(webhookSubscriptionSchema)) b: Infer<typeof webhookSubscriptionSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.updateSubscription(p, id, b, meta);
  }

  @Post('webhooks/:id/rotate-secret')
  @HttpCode(200)
  @SessionOnly()
  @RequirePermissions('workflows.manage')
  rotate(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.rotateSecret(p, id, meta);
  }

  @Delete('webhooks/:id')
  @RequirePermissions('workflows.manage')
  deleteSubscription(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.deleteSubscription(p, id, meta);
  }

  @Get('webhooks/:id/deliveries')
  @RequirePermissions('workflows.manage')
  deliveries(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.deliveries(p, id);
  }

  @Post('deliveries/:id/redeliver')
  @HttpCode(200)
  @RequirePermissions('workflows.manage')
  @ApiOperation({ summary: 'Queue a delivery again (same event id, so receivers can still drop repeats).' })
  redeliver(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.redeliver(p, id, meta);
  }
}

/** Workflows: event triggers, conditions and ticket/notification actions, with approvals. */
@ApiTags('workflows')
@ApiCookieAuth()
@ApiBearerAuth()
@StaffOnly()
@Controller({ path: 'workflows', version: '1' })
export class WorkflowsController {
  constructor(private readonly svc: AutomationService) {}

  @Get()
  @RequirePermissions('workflows.manage')
  list(@CurrentPrincipal() p: Principal) {
    return this.svc.workflows(p);
  }

  @Post()
  @RequirePermissions('workflows.manage')
  @ApiZodBody(workflowSchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(workflowSchema)) b: Infer<typeof workflowSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.createWorkflow(p, b, meta);
  }

  @Post('dry-run')
  @HttpCode(200)
  @RequirePermissions('workflows.manage')
  @ApiOperation({ summary: 'Evaluate a workflow against a stored or sample event. Nothing is executed or stored.' })
  @ApiZodBody(dryRunSchema)
  dryRun(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(dryRunSchema)) b: Infer<typeof dryRunSchema>) {
    return this.svc.dryRun(p, b);
  }

  @Get('runs')
  @RequirePermissions('workflows.manage')
  @ApiZodQuery(runQuery)
  runs(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(runQuery)) q: Infer<typeof runQuery>) {
    return this.svc.runs(p, q);
  }

  @Post('runs/:id/approve')
  @HttpCode(200)
  @SessionOnly()
  @RequirePermissions('workflows.manage')
  @ApiOperation({ summary: 'Approve the action a run is waiting on. The last editor of the workflow cannot approve. Session only.' })
  @ApiZodBody(runDecisionSchema)
  approve(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(runDecisionSchema)) b: Infer<typeof runDecisionSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.decide(p, id, true, b, meta);
  }

  @Post('runs/:id/reject')
  @HttpCode(200)
  @SessionOnly()
  @RequirePermissions('workflows.manage')
  @ApiZodBody(runDecisionSchema)
  reject(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(runDecisionSchema)) b: Infer<typeof runDecisionSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.decide(p, id, false, b, meta);
  }

  @Put(':id')
  @RequirePermissions('workflows.manage')
  @ApiOperation({ summary: 'Replace a workflow (new version). Runs waiting for approval on the old version are rejected.' })
  @ApiZodBody(workflowSchema)
  update(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(workflowSchema)) b: Infer<typeof workflowSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.updateWorkflow(p, id, b, meta);
  }

  @Delete(':id')
  @RequirePermissions('workflows.manage')
  remove(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.deleteWorkflow(p, id, meta);
  }
}
