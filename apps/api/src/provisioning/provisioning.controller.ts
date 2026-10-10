import { Body, Controller, Delete, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import {
  bootCallbackSchema,
  controlCredentialSchema,
  guestActionSchema,
  guestAssignSchema,
  guestListQuerySchema,
  hostMapSchema,
  installSchema,
  jobListQuerySchema,
  osImageSchema,
  powerActionSchema,
  recoveryDecisionSchema,
  virtIntegrationSchema,
} from '@crapplet/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, Public, ReqMeta, RequirePermissions, StaffOnly } from '../auth/decorators';
import { normalizeIp, type AppRequest, type Principal, type RequestMeta } from '../auth/principal';
import { ProvisioningService } from './provisioning.service';
import { BootService } from './boot.service';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;
const UUID = new ParseUUIDPipe();
const IDEM = 'idempotency-key';

/**
 * Provisioning jobs, power control, OS images and hypervisors. Reads need
 * `provisioning.read`; installs, images and credentials `provisioning.execute`
 * (staff); power and VM actions `hardware.control` (customers: their own
 * equipment). Every action is a job the worker runs and verifies; a request
 * returning 201 means "queued", not "done".
 */
@ApiTags('provisioning')
@ApiCookieAuth()
@Controller({ path: 'provisioning', version: '1' })
export class ProvisioningController {
  constructor(private readonly svc: ProvisioningService) {}

  @Get('summary')
  @RequirePermissions('provisioning.read')
  @StaffOnly()
  summary(@CurrentPrincipal() p: Principal) {
    return this.svc.summary(p);
  }

  /** Staff need provisioning.read; customers with hardware.control see the power and VM actions on their own equipment. */
  @Get('jobs')
  @ApiZodQuery(jobListQuerySchema)
  jobs(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(jobListQuerySchema)) q: Infer<typeof jobListQuerySchema>) {
    return this.svc.jobs(p, q);
  }

  @Get('jobs/:id')
  job(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.job(p, id);
  }

  @Post('jobs/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  @ApiOperation({ summary: 'Cancel a job. A queued job stops at once; a running one at the next step, after its cleanup (media ejected, boot override cleared).' })
  cancel(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.cancel(p, id, meta);
  }

  @Post('jobs/:id/recovery')
  @HttpCode(200)
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  @ApiOperation({ summary: 'Decide what a job in recovery does next: retry the interrupted step, skip it (you checked it happened), or fail the job.' })
  @ApiZodBody(recoveryDecisionSchema)
  recover(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(recoveryDecisionSchema)) d: Infer<typeof recoveryDecisionSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.recover(p, id, d, meta);
  }

  @Post('installs')
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  @ApiOperation({ summary: "Queue an OS installation. Erases the server's disks: `confirm` must be the server's hostname or asset tag and `wipeAcknowledged` true. Honors the Idempotency-Key header." })
  @ApiZodBody(installSchema)
  install(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(installSchema)) b: Infer<typeof installSchema>, @Headers(IDEM) idem: string | undefined, @ReqMeta() meta: RequestMeta) {
    return this.svc.install(p, b, idem, meta);
  }

  /* -------------------------------------------------------------- power control */

  @Get('devices/:id/control')
  @RequirePermissions('hardware.control')
  control(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.controlStatus(p, id);
  }

  @Put('devices/:id/control')
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  @ApiOperation({ summary: 'Set the BMC credential used for power control and installs. Write-only: the password is never returned.' })
  @ApiZodBody(controlCredentialSchema)
  putControl(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(controlCredentialSchema)) b: Infer<typeof controlCredentialSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.putControlCredential(p, id, b, meta);
  }

  @Delete('devices/:id/control')
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  deleteControl(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.deleteControlCredential(p, id, meta);
  }

  @Post('devices/:id/power-actions')
  @RequirePermissions('hardware.control')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({ summary: "Queue a power action. `confirm` must be the server's hostname or asset tag. Completes only once the BMC reports the expected state." })
  @ApiZodBody(powerActionSchema)
  powerAction(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(powerActionSchema)) b: Infer<typeof powerActionSchema>, @Headers(IDEM) idem: string | undefined, @ReqMeta() meta: RequestMeta) {
    return this.svc.powerAction(p, id, b, idem, meta);
  }

  /* -------------------------------------------------------------- images */

  @Get('images')
  @RequirePermissions('provisioning.read')
  @StaffOnly()
  images(@CurrentPrincipal() p: Principal) {
    return this.svc.images(p);
  }

  @Post('images')
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  @ApiZodBody(osImageSchema)
  createImage(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(osImageSchema)) b: Infer<typeof osImageSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.createImage(p, b, meta);
  }

  @Put('images/:id')
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  @ApiOperation({ summary: 'Replace an image. Changing a file URL or checksum resets it to unverified.' })
  @ApiZodBody(osImageSchema)
  updateImage(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(osImageSchema)) b: Infer<typeof osImageSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.updateImage(p, id, b, meta);
  }

  @Delete('images/:id')
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  deleteImage(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.deleteImage(p, id, meta);
  }

  @Post('images/:id/verify')
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  @ApiOperation({ summary: 'Download the image files and compare their SHA-256 with the recorded checksums. Images must be verified before they can be installed.' })
  verifyImage(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Headers(IDEM) idem: string | undefined, @ReqMeta() meta: RequestMeta) {
    return this.svc.verifyImage(p, id, idem, meta);
  }
}

/** Proxmox and Virtualizor. */
@ApiTags('virtualization')
@ApiCookieAuth()
@Controller({ path: 'virtualization', version: '1' })
export class VirtualizationController {
  constructor(private readonly svc: ProvisioningService) {}

  @Get('integrations')
  @RequirePermissions('services.read')
  @StaffOnly()
  integrations(@CurrentPrincipal() p: Principal) {
    return this.svc.integrations(p);
  }

  @Post('integrations')
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  @ApiOperation({ summary: 'Add a hypervisor. Secrets are write-only. Proxmox VM actions need a separate action token; Virtualizor actions an explicit opt-in.' })
  @ApiZodBody(virtIntegrationSchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(virtIntegrationSchema)) b: Infer<typeof virtIntegrationSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.createIntegration(p, b, meta);
  }

  @Put('integrations/:id')
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  @ApiZodBody(virtIntegrationSchema)
  update(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(virtIntegrationSchema)) b: Infer<typeof virtIntegrationSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.updateIntegration(p, id, b, meta);
  }

  @Delete('integrations/:id')
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  remove(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.deleteIntegration(p, id, meta);
  }

  @Post('integrations/:id/sync')
  @HttpCode(200)
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  sync(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() meta: RequestMeta) {
    return this.svc.syncNow(p, id, meta);
  }

  @Get('hosts')
  @RequirePermissions('services.read')
  @StaffOnly()
  hosts(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(z.object({ integrationId: z.string().uuid().optional() }))) q: { integrationId?: string }) {
    return this.svc.hosts(p, q.integrationId);
  }

  @Put('hosts/:id/device')
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  @ApiZodBody(hostMapSchema)
  mapHost(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(hostMapSchema)) b: Infer<typeof hostMapSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.mapHost(p, id, b.deviceId, meta);
  }

  @Get('guests')
  @RequirePermissions('services.read')
  @ApiZodQuery(guestListQuerySchema)
  guests(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(guestListQuerySchema)) q: Infer<typeof guestListQuerySchema>) {
    return this.svc.guests(p, q);
  }

  @Put('guests/:id/customer')
  @RequirePermissions('provisioning.execute')
  @StaffOnly()
  @ApiZodBody(guestAssignSchema)
  assign(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(guestAssignSchema)) b: Infer<typeof guestAssignSchema>, @ReqMeta() meta: RequestMeta) {
    return this.svc.assignGuest(p, id, b.customerId, meta);
  }

  @Post('guests/:id/actions')
  @RequirePermissions('hardware.control')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiZodBody(guestActionSchema)
  guestAction(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(guestActionSchema)) b: Infer<typeof guestActionSchema>, @Headers(IDEM) idem: string | undefined, @ReqMeta() meta: RequestMeta) {
    return this.svc.guestAction(p, id, b, idem, meta);
  }
}

/**
 * Endpoints the installing server itself calls. No session: access is limited
 * to CDCIM_BOOT_ALLOW networks, an active job, and the job's boot token or MAC.
 */
@ApiTags('boot')
@Public()
@Controller({ path: 'boot', version: '1' })
export class BootController {
  constructor(private readonly boot: BootService) {}

  private static ip(req: AppRequest) {
    return normalizeIp(req.ip);
  }

  @Get('ipxe')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  ipxeByMac(@Query('mac') mac: string | undefined, @Req() req: AppRequest) {
    return this.boot.ipxe({ mac: typeof mac === 'string' ? mac : undefined }, BootController.ip(req));
  }

  @Get('ipxe/:token')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  ipxeByToken(@Param('token') token: string, @Req() req: AppRequest) {
    return this.boot.ipxe({ token }, BootController.ip(req));
  }

  @Get('config')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async configByMac(@Query('mac') mac: string | undefined, @Req() req: AppRequest) {
    return (await this.boot.config({ mac: typeof mac === 'string' ? mac : undefined }, BootController.ip(req))).body;
  }

  @Get('config/:token')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async configByToken(@Param('token') token: string, @Req() req: AppRequest) {
    return (await this.boot.config({ token }, BootController.ip(req))).body;
  }

  /** Autoinstall (cloud-init NoCloud) fetches `<url>user-data` and `<url>meta-data`. */
  @Get('config/:token/user-data')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async userData(@Param('token') token: string, @Req() req: AppRequest) {
    return (await this.boot.config({ token }, BootController.ip(req))).body;
  }

  @Get('config/:token/meta-data')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  metaData() {
    return '';
  }

  @Post('callback/:token')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiZodBody(bootCallbackSchema)
  callback(@Param('token') token: string, @Body(new ZodPipe(bootCallbackSchema)) b: Infer<typeof bootCallbackSchema>, @Req() req: AppRequest) {
    return this.boot.callback(token, b, BootController.ip(req));
  }
}
