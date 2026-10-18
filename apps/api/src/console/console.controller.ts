import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { consoleCredentialSchema, consoleSessionSchema } from '@crapplet/shared';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions, StaffOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { ConsoleService } from './console.service';

const UUID = new ParseUUIDPipe();

/**
 * Remote console. Opening any console needs `hardware.console` (customers:
 * only their own servers). Setting console passwords needs
 * `provisioning.execute` and is staff-only. The connection itself is a
 * WebSocket at /api/v1/console/ws with the one-time ticket from POST sessions.
 */
@ApiTags('console')
@ApiCookieAuth()
@Controller({ path: 'console', version: '1' })
export class ConsoleController {
  constructor(private readonly svc: ConsoleService) {}

  @Get('devices/:id')
  @RequirePermissions('hardware.console')
  @ApiOperation({ summary: 'Which consoles are set up for this server, who is connected, and recent sessions.' })
  status(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.status(p, id);
  }

  @Put('devices/:id/credentials')
  @StaffOnly()
  @RequirePermissions('hardware.console', 'provisioning.execute')
  @ApiZodBody(consoleCredentialSchema)
  @ApiOperation({ summary: 'Set the VNC password, the Serial-over-LAN login or the BMC web address. Write-only.' })
  put(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(consoleCredentialSchema)) b: z.infer<typeof consoleCredentialSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.putCredential(p, id, b, m);
  }

  @Delete('devices/:id/credentials/:kind')
  @StaffOnly()
  @HttpCode(204)
  @RequirePermissions('hardware.console', 'provisioning.execute')
  async remove(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Param('kind') kind: string, @ReqMeta() m: RequestMeta) {
    await this.svc.deleteCredential(p, id, kind, m);
  }

  @Post('devices/:id/web')
  @StaffOnly()
  @RequirePermissions('hardware.console')
  @ApiOperation({ summary: "The BMC's own web console address (opened in a new tab; recorded in the audit log)." })
  web(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    return this.svc.openWeb(p, id, m);
  }

  @Post('devices/:id/sessions')
  @RequirePermissions('hardware.console')
  @ApiZodBody(consoleSessionSchema)
  @ApiOperation({ summary: 'Open a console: returns a one-time ticket for the WebSocket, valid for one minute.' })
  start(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(consoleSessionSchema)) b: z.infer<typeof consoleSessionSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.start(p, id, b.kind, m);
  }

  @Post('guests/:id/sessions')
  @RequirePermissions('hardware.console')
  @ApiOperation({ summary: "Open a VM's graphical console (Virtualizor): a one-time ticket for the WebSocket, valid for one minute." })
  startGuest(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    return this.svc.startGuest(p, id, m);
  }

  @Post('sessions/:sid/end')
  @RequirePermissions('hardware.console')
  end(@CurrentPrincipal() p: Principal, @Param('sid', UUID) sid: string, @ReqMeta() m: RequestMeta) {
    return this.svc.end(p, sid, m);
  }
}
