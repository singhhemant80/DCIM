import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { createUserSchema, updateUserSchema, type CreateUserInput } from '@crapplet/shared';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../common/zod';
import { CurrentPrincipal, ReqMeta, RequirePermissions, StaffOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { UsersService, userListQuerySchema } from './users.service';

@ApiTags('users')
@ApiCookieAuth()
@StaffOnly()
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly usersSvc: UsersService) {}

  @Get()
  @RequirePermissions('users.read')
  @ApiZodQuery(userListQuerySchema)
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(userListQuerySchema)) q: z.infer<typeof userListQuerySchema>) {
    return this.usersSvc.list(p, q);
  }

  @Get(':id')
  @RequirePermissions('users.read')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.usersSvc.get(p, id);
  }

  @Post()
  @RequirePermissions('users.write')
  @ApiZodBody(createUserSchema)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(createUserSchema)) body: CreateUserInput, @ReqMeta() meta: RequestMeta) {
    return this.usersSvc.create(p, body, meta);
  }

  @Patch(':id')
  @RequirePermissions('users.write')
  @ApiZodBody(updateUserSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateUserSchema)) body: z.infer<typeof updateUserSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.usersSvc.update(p, id, body, meta);
  }

  @Post(':id/revoke-sessions')
  @HttpCode(200)
  @RequirePermissions('users.sessions.revoke')
  revokeSessions(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    return this.usersSvc.revokeSessions(p, id, meta);
  }

  @Post(':id/reset-mfa')
  @HttpCode(200)
  @RequirePermissions('users.write', 'users.sessions.revoke')
  async resetMfa(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    await this.usersSvc.resetMfa(p, id, meta);
    return { ok: true };
  }
}
