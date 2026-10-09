import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { emailSchema, passwordSchema } from '@crapplet/shared';
import { organizations, roles, userRoles, users } from '../db/schema';
import { provisionOrganization } from '../roles/provision';
import { PasswordService } from '../auth/password.service';
import { AuditService } from '../audit/audit.service';
import { arg, fail, withDb } from './common';

/**
 * Creates the first organization (if none exists) and a Super Administrator.
 *
 *   node dist/cli/create-admin.js --email admin@example.com --name "Admin" \
 *        [--org "Crapplet Infotech Private Limited"] [--org-slug crapplet]
 *
 * The password is read from CDCIM_ADMIN_PASSWORD; if unset, a strong random
 * password is generated and printed once. It is never logged elsewhere.
 */
withDb(async (db) => {
  const email = emailSchema.parse(arg('email'));
  const name = arg('name') ?? 'Administrator';
  const generated = !process.env.CDCIM_ADMIN_PASSWORD;
  const password = passwordSchema.parse(process.env.CDCIM_ADMIN_PASSWORD ?? randomBytes(18).toString('base64url'));

  const passwords = new PasswordService();
  const weak = passwords.weakness(password, { email });
  if (weak) throw new Error(weak);
  const passwordHash = await passwords.hash(password);

  await db.transaction(async (tx) => {
    let [org] = await tx.select().from(organizations).limit(1);
    if (!org) {
      org = await provisionOrganization(tx, {
        name: arg('org') ?? 'Crapplet Infotech Private Limited',
        slug: arg('org-slug') ?? 'crapplet',
      });
      process.stdout.write(`Created organization "${org.name}".\n`);
    }
    const [exists] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
    if (exists) throw new Error(`A user with email ${email} already exists`);
    const [role] = await tx.select().from(roles).where(and(eq(roles.orgId, org.id), eq(roles.systemKey, 'super_admin')));
    if (!role) throw new Error('super_admin role missing — run migrations first');
    const [u] = await tx.insert(users).values({ orgId: org.id, email, name, passwordHash, userType: 'staff' }).returning();
    await tx.insert(userRoles).values({ userId: u!.id, roleId: role.id });
    await new AuditService(tx as never).record(
      { orgId: org.id, actor: { type: 'system', label: 'cli:create-admin' }, action: 'user.create', target: { type: 'user', id: u!.id }, outcome: 'success', metadata: { email, role: 'super_admin' } },
      tx,
    );
  });

  process.stdout.write(`Super Administrator ${email} created.\n`);
  if (generated) process.stdout.write(`Generated password (shown once, store it securely): ${password}\n`);
}).catch(fail);

