import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { PERMISSIONS, createRoleSchema } from '@crapplet/shared';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions, StaffOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { RolesService } from './roles.service';

@ApiTags('roles')
@ApiCookieAuth()
@StaffOnly()
@Controller({ path: 'roles', version: '1' })
export class RolesController {
  constructor(private readonly rolesSvc: RolesService) {}

  @Get()
  @RequirePermissions('roles.read')
  list(@CurrentPrincipal() p: Principal) {
    return this.rolesSvc.list(p);
  }

  @Get('permissions')
  @RequirePermissions('roles.read')
  catalog() {
    return PERMISSIONS;
  }

  @Post()
  @RequirePermissions('roles.write')
  @ApiZodBody(createRoleSchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createRoleSchema)) body: z.infer<typeof createRoleSchema>, @ReqMeta() meta: RequestMeta) {
    return this.rolesSvc.create(p, body, meta);
  }

  @Patch(':id')
  @RequirePermissions('roles.write')
  @ApiZodBody(createRoleSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(createRoleSchema)) body: z.infer<typeof createRoleSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.rolesSvc.update(p, id, body, meta);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('roles.write')
  async remove(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    await this.rolesSvc.remove(p, id, meta);
  }
}
