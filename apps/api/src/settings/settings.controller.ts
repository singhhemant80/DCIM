import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { settingsSchema, type SettingsInput } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { organizations } from '../db/schema';
import { ApiZodBody, ZodPipe } from '../common/zod';
import { AuditService, actorFrom } from '../audit/audit.service';
import { CurrentPrincipal, ReqMeta, RequirePermissions, StaffOnly, SessionOnly } from '../auth/decorators';
import type { Principal, RequestMeta } from '../auth/principal';
import { DEFAULT_SESSION_IDLE_MINUTES, DEFAULT_SESSION_MAX_HOURS } from '../auth/session.service';

@ApiTags('settings')
@ApiCookieAuth()
@StaffOnly()
// Accounts, roles and security settings need a signed-in person: an API key can't change them.
@SessionOnly()
@Controller({ path: 'settings', version: '1' })
export class SettingsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('settings.read')
  async get(@CurrentPrincipal() p: Principal) {
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, p.orgId));
    return this.view(org!);
  }

  @Patch()
  @RequirePermissions('settings.write')
  @ApiZodBody(settingsSchema)
  async update(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(settingsSchema)) body: SettingsInput, @ReqMeta() meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      // Row lock so concurrent edits of different keys do not clobber each other.
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, p.orgId)).for('update');
      const { organizationName, ...rest } = body;
      const settings = { ...org!.settings, ...rest };
      const [updated] = await tx
        .update(organizations)
        .set({ settings, ...(organizationName && { name: organizationName }) })
        .where(eq(organizations.id, p.orgId))
        .returning();
      await this.audit.record(
        { orgId: p.orgId, actor: actorFrom(p), action: 'settings.update', target: { type: 'organization', id: p.orgId }, outcome: 'success', meta, metadata: { before: { name: org!.name, ...org!.settings }, changes: body } },
        tx,
      );
      return this.view(updated!);
    });
  }

  private view(org: typeof organizations.$inferSelect) {
    return {
      organizationName: org.name,
      slug: org.slug,
      timezone: org.settings.timezone ?? 'Asia/Kolkata',
      currency: org.settings.currency ?? 'INR',
      sessionIdleMinutes: org.settings.sessionIdleMinutes ?? DEFAULT_SESSION_IDLE_MINUTES,
      sessionMaxHours: org.settings.sessionMaxHours ?? DEFAULT_SESSION_MAX_HOURS,
      requireMfaForStaff: org.settings.requireMfaForStaff ?? false,
    };
  }
}
