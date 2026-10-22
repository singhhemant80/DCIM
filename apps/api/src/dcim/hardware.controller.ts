import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { accessorySchema, bmcSetupSchema, devicePhotoSchema, hardwareApplySchema, type BmcSetupInput } from '@crapplet/shared';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions, StaffOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { HardwareService } from './hardware.service';
import { BmcService } from './bmc.service';

const UUID = new ParseUUIDPipe();
const removeQuery = z.object({ returnToStock: z.enum(['true', 'false']).optional() });

@ApiTags('dcim: devices')
@ApiCookieAuth()
@Controller({ path: 'dcim/devices/:id', version: '1' })
export class DeviceHardwareController {
  constructor(
    private readonly svc: HardwareService,
    private readonly bmc: BmcService,
  ) {}

  @Get('bmc')
  @StaffOnly()
  @RequirePermissions('dcim.read')
  @ApiOperation({ summary: "The server's BMC and where it is used (monitoring, power readings, power control, consoles). Passwords are never returned." })
  bmcStatus(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.bmc.status(p, id);
  }

  @Put('bmc')
  @StaffOnly()
  @RequirePermissions('monitoring.configure')
  @ApiZodBody(bmcSetupSchema)
  @ApiOperation({ summary: 'Enter the BMC once: stored as the read-only monitoring credential and, when asked, for power control and the consoles (each under its own permission). Write-only.' })
  bmcSetup(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(bmcSetupSchema)) b: BmcSetupInput, @ReqMeta() m: RequestMeta) {
    return this.bmc.setup(p, id, b, m);
  }

  @Get('hardware')
  @RequirePermissions('dcim.read')
  @ApiOperation({ summary: 'Hardware read from the BMC (Redfish): CPUs, memory, drives, PSUs, fans, temperatures, NICs, firmware and, for staff, the event logs.' })
  hardware(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.hardware(p, id);
  }

  @Post('hardware/refresh')
  @StaffOnly()
  @RequirePermissions('dcim.write')
  @ApiOperation({ summary: 'Ask the worker to read the BMC again (read-only).' })
  refresh(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    return this.svc.refresh(p, id, m);
  }

  @Post('hardware/apply')
  @StaffOnly()
  @RequirePermissions('dcim.write')
  @ApiZodBody(hardwareApplySchema)
  @ApiOperation({ summary: 'Copy chosen fields (serial, CPU, RAM, disks, NICs, firmware) from the last BMC read into the device record.' })
  apply(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(hardwareApplySchema)) b: z.infer<typeof hardwareApplySchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.apply(p, id, b, m);
  }

  @Get('photo')
  @RequirePermissions('dcim.read')
  @ApiOperation({ summary: 'The front photo of the device (image bytes).' })
  async photo(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Res() res: Response) {
    const row = await this.svc.photo(p, id);
    res.setHeader('Content-Type', row.contentType);
    res.setHeader('Content-Length', String(row.size));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.end(row.data);
  }

  @Put('photo')
  @StaffOnly()
  @RequirePermissions('dcim.write')
  @ApiZodBody(devicePhotoSchema)
  putPhoto(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(devicePhotoSchema)) b: z.infer<typeof devicePhotoSchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.putPhoto(p, id, b, m);
  }

  @Delete('photo')
  @StaffOnly()
  @RequirePermissions('dcim.write')
  @HttpCode(204)
  deletePhoto(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @ReqMeta() m: RequestMeta) {
    return this.svc.deletePhoto(p, id, m);
  }

  @Get('accessories')
  @RequirePermissions('dcim.read')
  @ApiOperation({ summary: 'Cables, transceivers, rail kits, trays and other accessories fitted with the device.' })
  accessories(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string) {
    return this.svc.accessories(p, id);
  }

  @Post('accessories')
  @StaffOnly()
  @RequirePermissions('dcim.write')
  @ApiZodBody(accessorySchema)
  addAccessory(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Body(new ZodPipe(accessorySchema)) b: z.infer<typeof accessorySchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.addAccessory(p, id, b, m);
  }

  @Put('accessories/:accessoryId')
  @StaffOnly()
  @RequirePermissions('dcim.write')
  @ApiZodBody(accessorySchema)
  updateAccessory(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Param('accessoryId', UUID) aid: string, @Body(new ZodPipe(accessorySchema)) b: z.infer<typeof accessorySchema>, @ReqMeta() m: RequestMeta) {
    return this.svc.updateAccessory(p, id, aid, b, m);
  }

  @Delete('accessories/:accessoryId')
  @StaffOnly()
  @HttpCode(204)
  @RequirePermissions('dcim.write')
  async removeAccessory(@CurrentPrincipal() p: Principal, @Param('id', UUID) id: string, @Param('accessoryId', UUID) aid: string, @Query(new ZodPipe(removeQuery)) q: z.infer<typeof removeQuery>, @ReqMeta() m: RequestMeta) {
    await this.svc.removeAccessory(p, id, aid, q.returnToStock === 'true', m);
  }
}
