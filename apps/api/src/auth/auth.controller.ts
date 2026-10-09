import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { changePasswordSchema, loginSchema, mfaDisableSchema, mfaEnableSchema, mfaVerifySchema } from '@crapplet/shared';
import type { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Db } from '../db/db';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { AuditService } from '../audit/audit.service';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { AllowDuringMfaEnrollment, CurrentPrincipal, Public, ReqMeta } from './decorators';
import { clearSessionCookies, setSessionCookies } from './cookies';
import type { Principal, RequestMeta } from './principal';

// Login and re-authentication routes get a tighter per-IP budget on top of per-account lockout.
// Read from the environment at load time because decorators are static; the same variable is
// validated by loadConfig() at startup.
const LOGIN_THROTTLE = { default: { limit: Number(process.env.LOGIN_RATE_LIMIT_PER_MINUTE ?? 10), ttl: 60_000 } };

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Public()
  @Throttle(LOGIN_THROTTLE)
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with email and password. Returns mfaRequired + challengeToken when MFA is enabled.' })
  @ApiZodBody(loginSchema)
  async login(
    @Body(new ZodPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body.email, body.password, meta);
    if (result.kind === 'mfa') return { mfaRequired: true, challengeToken: result.challengeToken };
    setSessionCookies(res, result.issued, this.config.COOKIE_SECURE);
    return { mfaRequired: false };
  }

  @Public()
  @Throttle(LOGIN_THROTTLE)
  @Post('mfa/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete sign-in with a TOTP or recovery code.' })
  @ApiZodBody(mfaVerifySchema)
  async verifyMfa(
    @Body(new ZodPipe(mfaVerifySchema)) body: z.infer<typeof mfaVerifySchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { issued } = await this.auth.verifyMfaChallenge(body.challengeToken, body.code, meta);
    setSessionCookies(res, issued, this.config.COOKIE_SECURE);
    return { ok: true };
  }

  @AllowDuringMfaEnrollment()
  @Post('logout')
  @HttpCode(200)
  @ApiCookieAuth()
  async logout(@CurrentPrincipal() p: Principal, @ReqMeta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(p, meta);
    clearSessionCookies(res, this.config.COOKIE_SECURE);
    return { ok: true };
  }

  @AllowDuringMfaEnrollment()
  @Get('me')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Current user, organization, effective permissions and MFA state.' })
  me(@CurrentPrincipal() p: Principal) {
    return this.auth.profile(p);
  }

  @Throttle(LOGIN_THROTTLE)
  @Post('password')
  @HttpCode(200)
  @ApiCookieAuth()
  @ApiZodBody(changePasswordSchema)
  async changePassword(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.auth.changePassword(p, body.currentPassword, body.newPassword, meta);
    return { ok: true };
  }

  @AllowDuringMfaEnrollment()
  @Post('mfa/setup')
  @HttpCode(200)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Generate a new TOTP secret and QR code (MFA stays off until /mfa/enable succeeds).' })
  setupMfa(@CurrentPrincipal() p: Principal) {
    return this.auth.beginMfaSetup(p);
  }

  @AllowDuringMfaEnrollment()
  @Post('mfa/enable')
  @HttpCode(200)
  @ApiCookieAuth()
  @ApiZodBody(mfaEnableSchema)
  enableMfa(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(mfaEnableSchema)) body: z.infer<typeof mfaEnableSchema>, @ReqMeta() meta: RequestMeta) {
    return this.auth.enableMfa(p, body.code, meta);
  }

  @Throttle(LOGIN_THROTTLE)
  @Post('mfa/disable')
  @HttpCode(200)
  @ApiCookieAuth()
  @ApiZodBody(mfaDisableSchema)
  async disableMfa(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(mfaDisableSchema)) body: z.infer<typeof mfaDisableSchema>, @ReqMeta() meta: RequestMeta) {
    await this.auth.disableMfa(p, body.password, meta);
    return { ok: true };
  }

  @AllowDuringMfaEnrollment()
  @Get('sessions')
  @ApiCookieAuth()
  @ApiOperation({ summary: "List the current user's active sessions." })
  async mySessions(@CurrentPrincipal() p: Principal) {
    const list = await this.sessions.listForUser(p.userId);
    return list.map((s) => ({
      id: s.id,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      current: s.id === p.sessionId,
    }));
  }

  @AllowDuringMfaEnrollment()
  @Delete('sessions/:id')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Sign out one of your own sessions.' })
  async revokeMySession(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string, @ReqMeta() meta: RequestMeta) {
    const mine = (await this.sessions.listForUser(p.userId)).some((s) => s.id === id);
    if (!mine) throw new NotFoundException({ error: 'not_found', message: 'Session not found' });
    await this.db.transaction(async (tx) => {
      await this.sessions.revoke(id, 'user_revoked', tx);
      await this.audit.record({ orgId: p.orgId, actor: { type: 'user', id: p.userId, label: p.email }, customerId: p.customerId, action: 'auth.session.revoke', target: { type: 'session', id }, outcome: 'success', meta }, tx);
    });
    return { ok: true };
  }
}
