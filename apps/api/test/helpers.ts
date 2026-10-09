import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config/config';
import { createDb, createPool, runMigrations, type Db } from '../src/db/db';
import { customers, roles, userRoles, users, type Organization } from '../src/db/schema';
import { provisionOrganization } from '../src/roles/provision';
import { PasswordService } from '../src/auth/password.service';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://cdcim:cdcim_dev@127.0.0.1:5432/crapplet_dcim_test';
export const PASSWORD = 'Test-Only-Pass-phrase-77';

export interface TestUsers {
  superAdmin: string;
  noc: string;
  opsAdmin: string;
  acmeAdmin: string;
  globexAdmin: string;
}

export interface TestContext {
  app: INestApplication;
  server: Parameters<typeof request>[0];
  db: Db;
  org: Organization;
  customers: { acme: string; globex: string };
  emails: TestUsers;
  close: () => Promise<void>;
}

/** Guard against ever wiping a non-test database. */
function assertTestDb(url: string) {
  const name = new URL(url).pathname.slice(1);
  if (!/test/i.test(name)) throw new Error(`Refusing to reset database "${name}": name must contain "test"`);
}

/**
 * Wipes the test database, applies migrations, provisions an organization with
 * two customers and five users (one per interesting role), and boots the real
 * Nest application with production middleware.
 */
export async function setupTestApp(extraEnv: Record<string, string> = {}): Promise<TestContext> {
  assertTestDb(TEST_DATABASE_URL);
  const pool = createPool(TEST_DATABASE_URL, 10);
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  const db = createDb(pool);
  await runMigrations(db);

  const passwords = new PasswordService();
  const hash = await passwords.hash(PASSWORD);
  const org = await db.transaction((tx) => provisionOrganization(tx, { name: 'Test Org', slug: 'test' }));
  const [acme] = await db.insert(customers).values({ orgId: org.id, code: 'ACME', name: 'Acme', notes: 'staff-only note', billingReference: 'WHMCS-1' }).returning();
  const [globex] = await db.insert(customers).values({ orgId: org.id, code: 'GLOBEX', name: 'Globex' }).returning();

  const roleId = async (key: string) =>
    (await db.select().from(roles).where(and(eq(roles.orgId, org.id), eq(roles.systemKey, key))))[0]!.id;

  const emails: TestUsers = {
    superAdmin: 'root@test.example',
    noc: 'noc@test.example',
    opsAdmin: 'ops@test.example',
    acmeAdmin: 'boss@acme.example',
    globexAdmin: 'boss@globex.example',
  };
  const people = [
    { email: emails.superAdmin, role: 'super_admin', userType: 'staff' as const, customerId: null },
    { email: emails.noc, role: 'noc_engineer', userType: 'staff' as const, customerId: null },
    { email: emails.opsAdmin, role: 'operations_admin', userType: 'staff' as const, customerId: null },
    { email: emails.acmeAdmin, role: 'customer_admin', userType: 'customer' as const, customerId: acme!.id },
    { email: emails.globexAdmin, role: 'customer_admin', userType: 'customer' as const, customerId: globex!.id },
  ];
  for (const p of people) {
    const [u] = await db
      .insert(users)
      .values({ orgId: org.id, email: p.email, name: p.email.split('@')[0]!, passwordHash: hash, userType: p.userType, customerId: p.customerId })
      .returning();
    await db.insert(userRoles).values({ userId: u!.id, roleId: await roleId(p.role) });
  }

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379',
    CDCIM_ENCRYPTION_KEYS: `t1:${randomBytes(32).toString('base64')}`,
    LOG_LEVEL: 'silent',
    ...extraEnv,
  });
  const app = await createApp(config, pino({ level: 'silent' }));
  // Listen on an ephemeral port so concurrent supertest requests share one server.
  await app.listen(0, '127.0.0.1');

  return {
    app,
    server: app.getHttpServer(),
    db,
    org,
    customers: { acme: acme!.id, globex: globex!.id },
    emails,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

/** An authenticated browser-like client: keeps cookies and sends the CSRF header on unsafe methods. */
export class Client {
  private constructor(
    readonly agent: TestAgent,
    public csrf: string,
  ) {}

  static async login(server: TestContext['server'], email: string, password = PASSWORD): Promise<Client> {
    const agent = request.agent(server);
    const res = await agent.post('/api/v1/auth/login').send({ email, password });
    if (res.status !== 200 || res.body.mfaRequired) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    return new Client(agent, csrfFrom(res.headers['set-cookie']));
  }

  static fromAgent(agent: TestAgent, setCookie: unknown): Client {
    return new Client(agent, csrfFrom(setCookie));
  }

  get(path: string) {
    return this.agent.get(path);
  }
  post(path: string, body?: object) {
    return this.agent.post(path).set('X-CSRF-Token', this.csrf).send(body ?? {});
  }
  put(path: string, body: object) {
    return this.agent.put(path).set('X-CSRF-Token', this.csrf).send(body);
  }
  patch(path: string, body: object) {
    return this.agent.patch(path).set('X-CSRF-Token', this.csrf).send(body);
  }
  delete(path: string) {
    return this.agent.delete(path).set('X-CSRF-Token', this.csrf);
  }
}

export function csrfFrom(setCookie: unknown): string {
  const list = Array.isArray(setCookie) ? (setCookie as string[]) : [];
  const c = list.find((s) => s.startsWith('cdcim_csrf='));
  if (!c) throw new Error('no CSRF cookie in response');
  return decodeURIComponent(c.split(';')[0]!.split('=')[1]!);
}

export async function userId(db: Db, email: string): Promise<string> {
  return (await db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0]!.id;
}
