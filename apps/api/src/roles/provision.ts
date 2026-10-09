import { and, eq } from 'drizzle-orm';
import { DEFAULT_LIFECYCLE_TRANSITIONS, SYSTEM_ROLES } from '@crapplet/shared';
import type { DbOrTx } from '../db/db';
import { lifecycleTransitions, organizations, roles, type Organization } from '../db/schema';

/**
 * Creates (or updates) the built-in roles for an organization. Idempotent:
 * safe to run on every upgrade so new permissions reach system roles.
 */
export async function syncSystemRoles(tx: DbOrTx, orgId: string): Promise<void> {
  for (const def of SYSTEM_ROLES) {
    const [existing] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.systemKey, def.key)));
    if (existing) {
      await tx
        .update(roles)
        .set({ name: def.name, description: def.description, scope: def.scope, permissions: [...def.permissions] })
        .where(eq(roles.id, existing.id));
    } else {
      await tx.insert(roles).values({
        orgId,
        systemKey: def.key,
        name: def.name,
        description: def.description,
        scope: def.scope,
        permissions: [...def.permissions],
      });
    }
  }
}

export async function provisionOrganization(tx: DbOrTx, input: { name: string; slug: string }): Promise<Organization> {
  const [org] = await tx
    .insert(organizations)
    .values({
      name: input.name,
      slug: input.slug,
      settings: { timezone: 'Asia/Kolkata', currency: 'INR', sessionIdleMinutes: 60, sessionMaxHours: 12, requireMfaForStaff: false },
    })
    .returning();
  await syncSystemRoles(tx, org!.id);
  await syncLifecycleDefaults(tx, org!.id);
  return org!;
}

/** Seeds the default device lifecycle transitions for an organization that has none. Idempotent. */
export async function syncLifecycleDefaults(tx: DbOrTx, orgId: string): Promise<void> {
  const existing = await tx.select({ orgId: lifecycleTransitions.orgId }).from(lifecycleTransitions).where(eq(lifecycleTransitions.orgId, orgId)).limit(1);
  if (existing.length) return;
  await tx.insert(lifecycleTransitions).values(DEFAULT_LIFECYCLE_TRANSITIONS.map(([fromState, toState]) => ({ orgId, fromState, toState })));
}
