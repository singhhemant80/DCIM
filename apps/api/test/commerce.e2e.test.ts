import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { amountInWords } from '@crapplet/shared';
import { auditEvents, customers, ipAddresses, provisioningJobs, subscriptions, virtGuests } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { runDueJobs } from '../src/worker/provisioning/engine';
import { PROVISIONING_KINDS, syncDueIntegrations, type ProvisioningDeps } from '../src/worker/provisioning/kinds';
import { runBillingCycle } from '../src/worker/billing/cycle';
import { Client, setupTestApp, type TestContext } from './helpers';
import { startVirtualizor, type MockVirtualizor } from './simulators/provisioning-devices';

/* eslint-disable @typescript-eslint/no-explicit-any */
let ctx: TestContext;
let admin: Client;
let noc: Client;
let acme: Client;
let globex: Client;
let vz: MockVirtualizor;
const ids: Record<string, any> = {};
const B = '/api/v1/invoicing';
const V = '/api/v1/virtualization';
const ROOT_PW = 'Vps-Root-Pass-2026';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const clock = { t: Date.now() };

async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const deps = (): ProvisioningDeps => ({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, kinds: PROVISIONING_KINDS, now: () => new Date(clock.t), retryBaseMs: 1000, pollMs: 1000 });
const job = async (id: string) => (await ctx.db.select().from(provisioningJobs).where(eq(provisioningJobs.id, id)))[0]!;
async function drive(id: string) {
  for (let i = 0; i < 60; i++) {
    await runDueJobs(deps());
    const j = await job(id);
    if (['completed', 'failed', 'cancelled', 'recovery'].includes(j.status)) return j;
    clock.t += 2000;
  }
  throw new Error('job did not settle');
}
const balance = async (id: string) => (await ctx.db.select().from(customers).where(eq(customers.id, id)))[0]!.walletBalancePaise;
const DAY = 86_400_000;

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  globex = await Client.login(ctx.server, ctx.emails.globexAdmin);
  vz = await startVirtualizor('VZKEY123', 'vz-api-pass-77');
  await ok(admin.post('/api/v1/ipam/prefixes', { prefix: '203.0.113.0/24', status: 'active' }));
  const i = await ok(admin.post(`${V}/integrations`, { kind: 'virtualizor', name: 'VZ panel', url: `http://127.0.0.1:${vz.port}`, verifyTls: false, apiKey: 'VZKEY123', apiPass: 'vz-api-pass-77', actionsEnabled: true, syncMinutes: 10 }));
  ids.integration = i.id;
  await syncDueIntegrations(deps(), { force: i.id });
  // Acme: GST-registered in Maharashtra (another state → IGST). Globex: no GSTIN, same state as us (→ CGST + SGST).
  await ctx.db.update(customers).set({ contactEmail: 'it@acme.example' }).where(eq(customers.id, ctx.customers.acme));
  await ctx.db.update(customers).set({ contactEmail: 'ops@globex.example' }).where(eq(customers.id, ctx.customers.globex));
});

afterAll(async () => {
  await vz?.close();
  await ctx?.close();
});

describe('setup', () => {
  it('needs billing settings before orders and validates the GSTIN', async () => {
    expect((await noc.get(`${B}/settings`)).status).toBe(403);
    expect((await acme.get(`${B}/settings`)).status).toBe(403);
    const bad = await admin.put(`${B}/settings`, { legalName: 'Crapplet Cloud Pvt Ltd', address: 'Plot 5, Sector 62, Noida', stateCode: '09', gstin: '09AAACC1234X1Z9' });
    expect(bad.status).toBe(400);
    // A valid GSTIN (check digit) registered in another state than the one chosen.
    const wrongState = await admin.put(`${B}/settings`, { legalName: 'Crapplet Cloud Pvt Ltd', address: 'Plot 5, Sector 62, Noida', stateCode: '07', gstin: '09AAACC1234F1Z6' });
    expect(wrongState.status).toBe(400);
    const s = await ok(admin.put(`${B}/settings`, { legalName: 'Crapplet Cloud Pvt Ltd', address: 'Plot 5, Sector 62, Noida, Uttar Pradesh 201309', stateCode: '09', gstin: '09AAACC1234F1Z6', pan: 'AAACC1234F', graceDays: 3 }));
    expect(s).toMatchObject({ gstRateBp: 1800, sacCode: '998315', invoicePrefix: 'INV' });
  });

  it('offers Virtualizor plans from the sync at a price, with client prices', async () => {
    const hv = await ok(admin.get(`${B}/hypervisor-plans`));
    expect(hv[0].plans.map((p: any) => p.name)).toEqual(['KVM 2G', 'KVM 4G']);
    expect(hv[0].plans[0]).toMatchObject({ id: '3', ramMb: 2048, diskGb: 40, cores: 2, speedMbps: 102 });
    const plan = await ok(admin.post(`${B}/plans`, { integrationId: ids.integration, externalPlanId: '3', name: 'VPS 2 GB', pricePaise: 50_000, osIds: [] }));
    ids.plan = plan.id;
    expect(plan.specs).toMatchObject({ ramMb: 2048 });
    expect((await admin.post(`${B}/plans`, { integrationId: ids.integration, externalPlanId: '3', name: 'dup', pricePaise: 100 })).status).toBe(409);
    expect((await admin.post(`${B}/plans`, { integrationId: ids.integration, externalPlanId: '99', name: 'nope', pricePaise: 100 })).status).toBe(400);
    // Globex pays ₹400 instead of ₹500.
    const prices = await ok(admin.put(`${B}/customers/${ctx.customers.globex}/prices`, { planId: ids.plan, pricePaise: 40_000 }));
    expect(prices[0]).toMatchObject({ defaultPricePaise: 50_000, clientPricePaise: 40_000 });
    // Each client sees only their own price, with GST for their state.
    const forGlobex = await ok(globex.get(`${B}/plans`));
    expect(forGlobex).toHaveLength(1);
    expect(forGlobex[0]).toMatchObject({ pricePaise: 40_000, gstPaise: 7_200, totalPaise: 47_200 });
    expect(forGlobex[0].integrationId).toBeUndefined();
    expect((await ok(acme.get(`${B}/plans`)))[0]).toMatchObject({ pricePaise: 50_000 });
    // OS templates of the plan's type (kvm), not the openvz one.
    expect((await ok(acme.get(`${B}/plans/${ids.plan}/templates`))).map((t: any) => t.name)).toEqual(['almalinux-9-x86_64', 'ubuntu-22.04-x86_64']);
    expect((await acme.get(`${B}/customers/${ctx.customers.acme}/prices`)).status).toBe(403);
  });

  it('keeps client billing profiles to the right account', async () => {
    expect((await acme.put(`${B}/customers/${ctx.customers.globex}/profile`, { gstin: '27AAACA1234Q1ZN' })).status).toBe(404);
    const a = await ok(acme.put(`${B}/customers/${ctx.customers.acme}/profile`, { legalName: 'Acme Industries Pvt Ltd', gstin: '27AAACA1234Q1ZN', address: 'Andheri East, Mumbai' }));
    expect(a.customer).toMatchObject({ gstin: '27AAACA1234Q1ZN', stateCode: '27' });
  });
});

describe('wallet', () => {
  it('adds funds with a receipt, once per Idempotency-Key, staff only', async () => {
    expect((await acme.post(`${B}/customers/${ctx.customers.acme}/funds`, { amountPaise: 100_000, method: 'upi' })).status).toBe(403);
    expect((await noc.post(`${B}/customers/${ctx.customers.acme}/funds`, { amountPaise: 100_000, method: 'upi' })).status).toBe(403);
    const r1 = await ok(admin.post(`${B}/customers/${ctx.customers.acme}/funds`, { amountPaise: 100_000, method: 'upi', reference: 'UTR123' }).set('Idempotency-Key', 'pay-1'));
    const r2 = await ok(admin.post(`${B}/customers/${ctx.customers.acme}/funds`, { amountPaise: 100_000, method: 'upi', reference: 'UTR123' }).set('Idempotency-Key', 'pay-1'));
    expect(r1.receiptNumber).toMatch(/^RCPT\/\d\d-\d\d\/0001$/);
    expect(r2).toMatchObject({ receiptNumber: r1.receiptNumber, replayed: true });
    expect(await balance(ctx.customers.acme)).toBe(100_000);
    const rc = await ok(acme.get(`${B}/receipts/${r1.transactionId}`));
    expect(rc).toMatchObject({ number: r1.receiptNumber, amountPaise: 100_000, method: 'upi' });
    expect((await globex.get(`${B}/receipts/${r1.transactionId}`)).status).toBe(404);
    ids.receiptTx = r1.transactionId;
  });

  it('keeps the ledger append-only', async () => {
    await expect(ctx.db.execute(sql`update wallet_transactions set amount_paise = 1 where id = ${ids.receiptTx}`)).rejects.toThrow();
    await expect(ctx.db.execute(sql`delete from wallet_transactions where id = ${ids.receiptTx}`)).rejects.toThrow();
  });
});

describe('orders', () => {
  it('refuses an order the wallet cannot pay, taking nothing', async () => {
    const r = await globex.post(`${B}/orders`, { planId: ids.plan, hostname: 'vps-g1.globex.example', osId: '270', password: ROOT_PW });
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ error: 'insufficient_funds', balancePaise: 0, neededPaise: 47_200 });
    expect(await ctx.db.select().from(provisioningJobs).where(eq(provisioningJobs.kind, 'guest_create'))).toHaveLength(0);
  });

  it('validates the OS and the password', async () => {
    expect((await acme.post(`${B}/orders`, { planId: ids.plan, hostname: 'vps1.acme.example', osId: '448', password: ROOT_PW })).status).toBe(400);
    expect((await acme.post(`${B}/orders`, { planId: ids.plan, hostname: 'vps1.acme.example', osId: '270', password: 'short' })).status).toBe(400);
    // Choosing the server is for staff; an unknown server is refused.
    expect((await acme.post(`${B}/orders`, { planId: ids.plan, hostname: 'vps1.acme.example', osId: '270', password: ROOT_PW, serverId: '1' })).status).toBe(403);
    expect((await admin.post(`${B}/orders`, { customerId: ctx.customers.acme, planId: ids.plan, hostname: 'vps1.acme.example', osId: '270', password: ROOT_PW, serverId: '999' })).status).toBe(400);
    const hv = await ok(admin.get(`${B}/hypervisor-plans`));
    expect(hv[0].servers.length).toBeGreaterThan(0);
    expect(hv[0].servers[0]).toMatchObject({ id: expect.any(String), name: expect.any(String), vms: expect.any(Number) });
  });

  it('takes price + GST from the wallet, creates the VPS, and invoices it with IGST', async () => {
    const res = await ok(acme.post(`${B}/orders`, { planId: ids.plan, hostname: 'vps1.acme.example', osId: '270', password: ROOT_PW }).set('Idempotency-Key', 'order-1'));
    const again = await ok(acme.post(`${B}/orders`, { planId: ids.plan, hostname: 'vps1.acme.example', osId: '270', password: ROOT_PW }).set('Idempotency-Key', 'order-1'));
    expect(again).toMatchObject({ replayed: true, order: { id: res.order.id } });
    expect(res.order).toMatchObject({ status: 'provisioning', pricePaise: 50_000, taxPaise: 9_000, totalPaise: 59_000 });
    expect(await balance(ctx.customers.acme)).toBe(41_000);
    const [j] = await ctx.db.select().from(provisioningJobs).where(eq(provisioningJobs.kind, 'guest_create'));
    // The passwords are encrypted in the job, never in its parameters.
    expect(JSON.stringify(j!.params)).not.toContain(ROOT_PW);
    expect(j!.secretEnc).toBeTruthy();
    const done = await drive(j!.id);
    expect(done.status).toBe('completed');
    expect(done.secretEnc).toBeNull();
    // Sent to Virtualizor as Create VPS: plan, OS, owner, password in the POST body only.
    const c = vz.creates.at(-1)!;
    expect(c.body).toMatchObject({ addvps: '1', node_select: '1', slave_server: 'auto', plid: '3', osid: '270', hostname: 'vps1.acme.example', rootpass: ROOT_PW, user_email: 'it@acme.example', virt: 'kvm' });
    expect(c.query).toMatchObject({ virt: 'kvm' });
    // The plan gives the resources and storage: none are sent.
    for (const k of ['ram', 'space', 'cores', 'bandwidth', 'num_ips', 'space[0][st_uuid]']) expect(c.body[k]).toBeUndefined();
    expect(JSON.stringify(c.query)).not.toContain(ROOT_PW);
    // The new VPS is in inventory, assigned to Acme, its address in IPAM for Acme.
    const [g] = await ctx.db.select().from(virtGuests).where(eq(virtGuests.id, done.guestId!));
    expect(g).toMatchObject({ name: 'vps1.acme.example', customerId: ctx.customers.acme });
    const [ip] = await ctx.db.select().from(ipAddresses).where(eq(ipAddresses.guestId, g!.id));
    expect(ip).toMatchObject({ customerId: ctx.customers.acme, status: 'allocated' });
    ids.guest = g!.id;

    clock.t = Date.now();
    expect((await runBillingCycle(deps(), new Date())).settled).toBe(1);
    const acc = await ok(acme.get(`${B}/account`));
    expect(acc.orders[0]).toMatchObject({ status: 'active', guestName: 'vps1.acme.example' });
    expect(acc.subscriptions).toHaveLength(1);
    expect(acc.subscriptions[0]).toMatchObject({ status: 'active', pricePaise: 50_000 });
    expect(acc.invoices).toHaveLength(1);
    const inv = await ok(acme.get(`${B}/invoices/${acc.invoices[0].id}`));
    expect(inv).toMatchObject({ number: expect.stringMatching(/^INV\/\d\d-\d\d\/0001$/), placeOfSupply: '27', taxablePaise: 50_000, igstPaise: 9_000, cgstPaise: 0, sgstPaise: 0, totalPaise: 59_000 });
    expect(inv.recipient).toMatchObject({ name: 'Acme Industries Pvt Ltd', gstin: '27AAACA1234Q1ZN' });
    expect(inv.supplier).toMatchObject({ gstin: '09AAACC1234F1Z6' });
    expect(inv.lines[0]).toMatchObject({ sac: '998315', amountPaise: 50_000 });
    expect(amountInWords(inv.totalPaise)).toBe('Rupees Five Hundred Ninety Only');
    // The order's wallet debit points at the invoice; a service record exists.
    expect(acc.transactions.find((t: any) => t.kind === 'debit').invoiceId).toBe(inv.id);
    expect((await ok(acme.get('/api/v1/services'))).items.some((s: any) => s.name === 'vps1.acme.example' && s.kind === 'vps' && s.status === 'active')).toBe(true);
    // Other clients see none of it; invoices can't be changed.
    expect((await globex.get(`${B}/invoices/${inv.id}`)).status).toBe(404);
    expect((await ok(globex.get(`${B}/invoices`))).length).toBe(0);
    await expect(ctx.db.execute(sql`update invoices set total_paise = 1 where id = ${inv.id}`)).rejects.toThrow();
    // The client's VM page shows its renewal date and offers the console; staff-only fields stay hidden.
    const vm = await ok(acme.get(`/api/v1/virtualization/guests/${g!.id}`));
    expect(vm.billing).toMatchObject({ status: 'active', pricePaise: 50_000 });
    const vms = await ok(acme.get(`/api/v1/virtualization/guests?kind=virtualizor`));
    expect(vms.items.find((x: { id: string }) => x.id === g!.id).renewal).toMatchObject({ status: 'active' });
    expect(vm.can.console).toBe(true);
    expect(vm.hostName).toBeNull();
    expect(vm.customerName).toBeNull();
    // Staff see VMs per client, with billing; clients don't get this view.
    const byClient = await ok(admin.get('/api/v1/virtualization/guests/by-customer?kind=virtualizor'));
    expect(byClient.find((r: { customerId: string | null }) => r.customerId === ctx.customers.acme)).toMatchObject({ vms: 1, subscriptions: 1, monthlyPaise: 50_000, ips: 1 });
    expect(byClient.find((r: { customerId: string | null }) => r.customerId === null)).toMatchObject({ name: 'Own (no client)' });
    expect((await acme.get('/api/v1/virtualization/guests/by-customer')).status).toBe(404);
    // A client's VPS address outside any IPAM subnet is still theirs for traffic; not another client's.
    const [ext] = await ctx.db
      .insert(virtGuests)
      .values({ orgId: ctx.org.id, integrationId: g!.integrationId, externalId: '9901', name: 'outside.acme.example', status: 'running', customerId: ctx.customers.acme, ipAddresses: ['198.51.100.77'] })
      .returning();
    expect((await acme.get('/api/v1/monitoring/flows/ips/198.51.100.77/history?range=24h')).status).toBe(200);
    expect((await globex.get('/api/v1/monitoring/flows/ips/198.51.100.77/history?range=24h')).status).toBe(404);
    await ctx.db.delete(virtGuests).where(eq(virtGuests.id, ext!.id));
    // Delivered orders show when they renew.
    expect(acc.orders[0].nextDueAt).toBeTruthy();
    expect(acc.subscriptions[0].ipAddresses).toEqual(['203.0.113.13']);
    // Running the cycle again settles nothing twice.
    expect((await runBillingCycle(deps(), new Date())).settled).toBe(0);
    expect(await balance(ctx.customers.acme)).toBe(41_000);
  });

  it('refunds an order Virtualizor refused', async () => {
    await ok(admin.post(`${B}/customers/${ctx.customers.globex}/funds`, { amountPaise: 60_000, method: 'bank_transfer', reference: 'NEFT-9' }));
    vz.failCreate = 'No free IP addresses in the pool';
    try {
      const res = await ok(globex.post(`${B}/orders`, { planId: ids.plan, hostname: 'vps-g1.globex.example', osId: '310', password: ROOT_PW }));
      // Same state as the supplier: CGST + SGST on Globex's own price.
      expect(res.order).toMatchObject({ pricePaise: 40_000, taxPaise: 7_200, totalPaise: 47_200 });
      expect(await balance(ctx.customers.globex)).toBe(12_800);
      const jobs = await ctx.db.select().from(provisioningJobs).where(eq(provisioningJobs.kind, 'guest_create'));
      const j = await drive(jobs.find((x) => x.params.orderId === res.order.id)!.id);
      expect(j.status).toBe('failed');
      expect(j.error).toContain('No free IP addresses');
      expect(j.error).not.toContain(ROOT_PW);
      expect((await runBillingCycle(deps(), new Date())).settled).toBe(1);
      expect(await balance(ctx.customers.globex)).toBe(60_000);
      const acc = await ok(globex.get(`${B}/account`));
      expect(acc.orders[0]).toMatchObject({ status: 'refunded' });
      expect(acc.invoices).toHaveLength(0);
      expect(acc.transactions[0]).toMatchObject({ kind: 'refund', amountPaise: 47_200 });
    } finally {
      vz.failCreate = null;
    }
  });

  it('sends an unclear outcome to review, then staff resolve it', async () => {
    const res = await ok(globex.post(`${B}/orders`, { planId: ids.plan, hostname: 'vps-g2.globex.example', osId: '270', password: ROOT_PW }));
    const jobs = await ctx.db.select().from(provisioningJobs).where(eq(provisioningJobs.kind, 'guest_create'));
    const jid = jobs.find((x) => x.params.orderId === res.order.id)!.id;
    // The request went out and no clear answer came back (e.g. a dropped connection): the worker records that and stops.
    await ctx.db
      .update(provisioningJobs)
      .set({ status: 'failed', error: 'socket hang up. The VPS may have been created', state: { createSent: true }, finishedAt: new Date() })
      .where(eq(provisioningJobs.id, jid));
    expect((await runBillingCycle(deps(), new Date())).settled).toBe(1);
    expect(await balance(ctx.customers.globex)).toBe(12_800);
    const o = (await ok(admin.get(`${B}/orders`))).find((x: any) => x.id === res.order.id);
    expect(o.status).toBe('review');
    expect((await globex.post(`${B}/orders/${o.id}/resolve`, { action: 'refund' })).status).toBe(403);
    await ok(admin.post(`${B}/orders/${o.id}/resolve`, { action: 'refund', reason: 'Checked the panel: not created' }));
    expect(await balance(ctx.customers.globex)).toBe(60_000);
    expect((await admin.post(`${B}/orders/${o.id}/resolve`, { action: 'refund' })).status).toBe(409);
  });
});

describe('renewals', () => {
  it('renews from the wallet, goes overdue when short, suspends after the grace days, and unsuspends on top-up', async () => {
    const [sub] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.customerId, ctx.customers.acme));
    // Due now: the wallet has ₹410, the renewal needs ₹590.
    await ctx.db
      .update(subscriptions)
      .set({ nextDueAt: new Date(Date.now() - 1000) })
      .where(eq(subscriptions.id, sub!.id));
    let r = await runBillingCycle(deps(), new Date());
    expect(r.overdue).toBe(1);
    let acc = await ok(acme.get(`${B}/account`));
    expect(acc.subscriptions[0]).toMatchObject({ status: 'overdue' });
    expect(new Date(acc.subscriptions[0].suspendsAt).getTime()).toBeGreaterThan(Date.now() + 2.9 * DAY);
    // Within the grace days nothing is suspended.
    r = await runBillingCycle(deps(), new Date(Date.now() + 2 * DAY));
    expect(r.suspended).toBe(0);
    expect(vz.vps.get(String((await ctx.db.select().from(virtGuests).where(eq(virtGuests.id, ids.guest)))[0]!.externalId))!.suspended).toBe(0);
    // After them, the VPS is suspended in Virtualizor.
    r = await runBillingCycle(deps(), new Date(Date.now() + 3 * DAY + 60_000));
    expect(r.suspended).toBe(1);
    const ext = (await ctx.db.select().from(virtGuests).where(eq(virtGuests.id, ids.guest)))[0]!.externalId;
    expect(vz.vps.get(ext)!.suspended).toBe(1);
    acc = await ok(acme.get(`${B}/account`));
    expect(acc.subscriptions[0]).toMatchObject({ status: 'suspended' });
    // Funds arrive: charged, invoiced, VPS unsuspended, a new month from today.
    await ok(admin.post(`${B}/customers/${ctx.customers.acme}/funds`, { amountPaise: 100_000, method: 'cash' }));
    const payDay = new Date(Date.now() + 4 * DAY);
    r = await runBillingCycle(deps(), payDay);
    expect(r).toMatchObject({ renewed: 1, unsuspended: 1 });
    expect(vz.vps.get(ext)!.suspended).toBe(0);
    acc = await ok(acme.get(`${B}/account`));
    expect(acc.subscriptions[0]).toMatchObject({ status: 'active', suspendedAt: null });
    expect(new Date(acc.subscriptions[0].nextDueAt).getTime()).toBeGreaterThan(payDay.getTime() + 27 * DAY);
    expect(acc.balancePaise).toBe(141_000 - 59_000);
    expect(acc.invoices).toHaveLength(2);
    expect(acc.invoices[0].number).toMatch(/\/0002$/);
    const audits = await ctx.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(sql`${auditEvents.action} like 'billing.%'`);
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['billing.order_placed', 'billing.order_delivered', 'billing.order_refunded', 'billing.overdue', 'billing.suspended', 'billing.renewed', 'billing.unsuspended', 'billing.funds_added']),
    );
  });

  it('cancels at the end of the period (client), keeps on request, and ends with the VPS suspended', async () => {
    const [sub] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.customerId, ctx.customers.acme));
    // A client may only stop renewing; refunds and deletion are for staff; other clients see nothing.
    expect((await acme.post(`${B}/subscriptions/${sub!.id}/cancel`, { when: 'now' })).status).toBe(403);
    expect((await acme.post(`${B}/subscriptions/${sub!.id}/cancel`, { when: 'end_of_period', deleteVps: true })).status).toBe(403);
    expect((await globex.post(`${B}/subscriptions/${sub!.id}/cancel`, { when: 'end_of_period' })).status).toBe(404);
    await ok(acme.post(`${B}/subscriptions/${sub!.id}/cancel`, { when: 'end_of_period', reason: 'Moving' }));
    let acc = await ok(acme.get(`${B}/account`));
    expect(new Date(acc.subscriptions[0].cancelAt).getTime()).toBe(new Date(acc.subscriptions[0].nextDueAt).getTime());
    await ok(acme.post(`${B}/subscriptions/${sub!.id}/actions`, { action: 'keep' }));
    acc = await ok(acme.get(`${B}/account`));
    expect(acc.subscriptions[0].cancelAt).toBeNull();
    await ok(acme.post(`${B}/subscriptions/${sub!.id}/cancel`, { when: 'end_of_period' }));
    const bal = await balance(ctx.customers.acme);
    // On the due date: no renewal charged, subscription ended, VPS suspended in Virtualizor.
    const due = new Date((await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, sub!.id)))[0]!.nextDueAt.getTime() + 60_000);
    const r = await runBillingCycle(deps(), due);
    expect(r.renewed).toBe(0);
    expect(await balance(ctx.customers.acme)).toBe(bal);
    const [after] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, sub!.id));
    expect(after).toMatchObject({ status: 'cancelled', pendingAction: null });
    const ext = (await ctx.db.select().from(virtGuests).where(eq(virtGuests.id, ids.guest)))[0]!.externalId;
    expect(vz.vps.get(ext)!.suspended).toBe(1);
    expect((await acme.post(`${B}/subscriptions/${sub!.id}/actions`, { action: 'keep' })).status).toBe(409);
  });

  it('cancels now with a GST credit note for the unused days, and deletes the VPS only with its name typed', async () => {
    // A fresh delivered VPS for Globex (same state: CGST + SGST).
    await ok(admin.post(`${B}/customers/${ctx.customers.globex}/funds`, { amountPaise: 100_000, method: 'cash' }));
    const res = await ok(globex.post(`${B}/orders`, { planId: ids.plan, hostname: 'vps-g3.globex.example', osId: '270', password: ROOT_PW }));
    const jobs = await ctx.db.select().from(provisioningJobs).where(eq(provisioningJobs.kind, 'guest_create'));
    await drive(jobs.find((x) => x.params.orderId === res.order.id)!.id);
    const t0 = new Date();
    await runBillingCycle(deps(), t0);
    const [sub] = await ctx.db
      .select()
      .from(subscriptions)
      .where(sql`${subscriptions.customerId} = ${ctx.customers.globex} and ${subscriptions.status} = 'active'`);
    const before = await balance(ctx.customers.globex);
    // Staff suspend and unsuspend by hand.
    await ok(admin.post(`${B}/subscriptions/${sub!.id}/actions`, { action: 'suspend' }));
    await runBillingCycle(deps(), t0);
    const ext = (await ctx.db.select().from(virtGuests).where(eq(virtGuests.id, sub!.guestId!)))[0]!.externalId;
    expect(vz.vps.get(ext)!.suspended).toBe(1);
    await ok(admin.post(`${B}/subscriptions/${sub!.id}/actions`, { action: 'unsuspend' }));
    await runBillingCycle(deps(), t0);
    expect(vz.vps.get(ext)!.suspended).toBe(0);
    // Deleting needs the VPS name.
    expect((await admin.post(`${B}/subscriptions/${sub!.id}/cancel`, { when: 'now', refund: 'unused', deleteVps: true, confirmHostname: 'wrong' })).status).toBe(400);
    expect((await admin.post(`${B}/subscriptions/${sub!.id}/cancel`, { when: 'end_of_period', refund: 'unused' })).status).toBe(400);
    const c = await ok(admin.post(`${B}/subscriptions/${sub!.id}/cancel`, { when: 'now', refund: 'unused', deleteVps: true, confirmHostname: 'vps-g3.globex.example', reason: 'Client request' }));
    // Almost the whole month unused: close to ₹400 + 18 % back, as a credit note.
    expect(c.creditNote.number).toMatch(/^CN\/\d\d-\d\d\/0001$/);
    expect(c.creditNote.totalPaise).toBeGreaterThan(46_000);
    expect(c.creditNote.totalPaise).toBeLessThanOrEqual(47_200);
    expect(await balance(ctx.customers.globex)).toBe(before + c.creditNote.totalPaise);
    const cns = await ok(globex.get(`${B}/credit-notes`));
    expect(cns).toHaveLength(1);
    const cn = await ok(globex.get(`${B}/credit-notes/${cns[0].id}`));
    expect(cn.cgstPaise + cn.sgstPaise).toBe(cn.totalPaise - cn.taxablePaise);
    expect(cn.igstPaise).toBe(0);
    expect((await acme.get(`${B}/credit-notes/${cns[0].id}`)).status).toBe(404);
    await expect(ctx.db.execute(sql`delete from credit_notes where id = ${cns[0].id}`)).rejects.toThrow();
    // The worker deletes the VPS in Virtualizor.
    await runBillingCycle(deps(), t0);
    expect(vz.vps.has(ext)).toBe(false);
    // Cancelled once only.
    expect((await admin.post(`${B}/subscriptions/${sub!.id}/cancel`, { when: 'now', refund: 'full' })).status).toBe(409);
  });

  it('lets the client choose what renews, renew by hand, and applies the suspend and terminate terms', async () => {
    const SETTINGS = { legalName: 'Crapplet Cloud Pvt Ltd', address: 'Plot 5, Sector 62, Noida, Uttar Pradesh 201309', stateCode: '09', gstin: '09AAACC1234F1Z6', pan: 'AAACC1234F', graceDays: 3 };
    expect((await admin.put(`${B}/settings`, { ...SETTINGS, terminateDays: 2 })).status).toBe(400);
    await ok(admin.put(`${B}/settings`, { ...SETTINGS, terminateDays: 7 }));
    await ok(admin.post(`${B}/customers/${ctx.customers.globex}/funds`, { amountPaise: 200_000, method: 'cash' }));
    const res = await ok(globex.post(`${B}/orders`, { planId: ids.plan, hostname: 'vps-g4.globex.example', osId: '270', password: ROOT_PW }));
    const jobs = await ctx.db.select().from(provisioningJobs).where(eq(provisioningJobs.kind, 'guest_create'));
    await drive(jobs.find((x) => x.params.orderId === res.order.id)!.id);
    await runBillingCycle(deps(), new Date());
    const [sub] = await ctx.db
      .select()
      .from(subscriptions)
      .where(sql`${subscriptions.customerId} = ${ctx.customers.globex} and ${subscriptions.status} = 'active'`);
    // The client turns auto-renew off: on the due date nothing is taken although the wallet could pay.
    await ok(globex.post(`${B}/subscriptions/${sub!.id}/actions`, { action: 'auto_renew_off' }));
    expect((await acme.post(`${B}/subscriptions/${sub!.id}/actions`, { action: 'auto_renew_on' })).status).toBe(404);
    expect((await globex.post(`${B}/subscriptions/${sub!.id}/actions`, { action: 'suspend' })).status).toBe(403);
    const due = new Date(Date.now() - 1000);
    await ctx.db.update(subscriptions).set({ nextDueAt: due }).where(eq(subscriptions.id, sub!.id));
    const before = await balance(ctx.customers.globex);
    await runBillingCycle(deps(), new Date());
    expect(await balance(ctx.customers.globex)).toBe(before);
    let acc = await ok(globex.get(`${B}/account`));
    let row = acc.subscriptions.find((x: { id: string }) => x.id === sub!.id);
    expect(row).toMatchObject({ status: 'overdue', autoRenew: false });
    expect(new Date(row.terminatesAt).getTime()).toBe(due.getTime() + 7 * DAY);
    // The client renews this one by hand: one month from the old due date, with an invoice.
    const r = await ok(globex.post(`${B}/subscriptions/${sub!.id}/actions`, { action: 'renew' }));
    expect(r.invoice.totalPaise).toBe(47_200);
    expect(await balance(ctx.customers.globex)).toBe(before - 47_200);
    acc = await ok(globex.get(`${B}/account`));
    row = acc.subscriptions.find((x: { id: string }) => x.id === sub!.id);
    expect(row.status).toBe('active');
    expect(new Date(row.nextDueAt).getTime()).toBeGreaterThan(due.getTime() + 27 * DAY);
    // Never renewed again: suspended after 3 days, terminated (VPS deleted) after 7.
    const due2 = new Date(Date.now() - 8 * DAY);
    await ctx.db.update(subscriptions).set({ nextDueAt: due2 }).where(eq(subscriptions.id, sub!.id));
    await runBillingCycle(deps(), new Date());
    expect((await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, sub!.id)))[0]!.status).toBe('overdue');
    const ext = (await ctx.db.select().from(virtGuests).where(eq(virtGuests.id, sub!.guestId!)))[0]!.externalId;
    const out = await runBillingCycle(deps(), new Date());
    expect(out.terminated).toBe(1);
    const [ended] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, sub!.id));
    expect(ended).toMatchObject({ status: 'cancelled', deleteVps: true, pendingAction: null });
    expect(vz.vps.has(ext)).toBe(false);
    expect((await globex.post(`${B}/subscriptions/${sub!.id}/actions`, { action: 'renew' })).status).toBe(409);
  });
});
