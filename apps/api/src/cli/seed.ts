import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { customers, organizations, roles, userRoles, users } from '../db/schema';
import { PasswordService } from '../auth/password.service';
import { fail, withDb } from './common';

/**
 * Development sample data: two customers and two example users (a NOC
 * engineer and a customer administrator). Refuses to run in production.
 * Idempotent — existing records are left untouched.
 */
withDb(async (db) => {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed sample data in production');
  const [org] = await db.select().from(organizations).limit(1);
  if (!org) throw new Error('No organization yet — run create-admin first');

  const sample = [
    { code: 'ACME', name: 'Acme Hosting Pvt Ltd', contactEmail: 'noc@acme.example' },
    { code: 'GLOBEX', name: 'Globex Trading LLP', contactEmail: 'it@globex.example' },
  ];
  for (const c of sample) {
    await db.insert(customers).values({ ...c, orgId: org.id, notes: 'Sample data (seed)' }).onConflictDoNothing();
  }
  const [acme] = await db.select().from(customers).where(and(eq(customers.orgId, org.id), eq(customers.code, 'ACME')));

  const passwords = new PasswordService();
  const password = process.env.CDCIM_SEED_PASSWORD ?? randomBytes(15).toString('base64url');
  const hash = await passwords.hash(password);
  const people = [
    { email: 'noc@crapplet.example', name: 'Sample NOC Engineer', userType: 'staff' as const, customerId: null, role: 'noc_engineer' },
    { email: 'admin@acme.example', name: 'Acme Portal Admin', userType: 'customer' as const, customerId: acme!.id, role: 'customer_admin' },
  ];
  const created: string[] = [];
  for (const person of people) {
    const [exists] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${person.email}`);
    if (exists) continue;
    const [role] = await db.select().from(roles).where(and(eq(roles.orgId, org.id), eq(roles.systemKey, person.role)));
    const [u] = await db
      .insert(users)
      .values({ orgId: org.id, email: person.email, name: person.name, passwordHash: hash, userType: person.userType, customerId: person.customerId })
      .returning();
    await db.insert(userRoles).values({ userId: u!.id, roleId: role!.id });
    created.push(person.email);
  }
  process.stdout.write(`Seeded ${sample.length} sample customers.\n`);
  if (created.length) process.stdout.write(`Sample users ${created.join(', ')} — password: ${password}\n`);
}).catch(fail);
