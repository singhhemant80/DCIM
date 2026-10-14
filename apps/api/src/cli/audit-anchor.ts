import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { auditEvents, organizations } from '../db/schema';
import type { Db } from '../db/db';
import { arg, fail, withDb } from './common';

/**
 * External anchors for the audit hash chain. The chain shows edits and
 * deletions in the middle of the log; an anchor (the newest event id and hash
 * per organization, written outside the database) also shows removal of the
 * newest events or a rebuilt chain.
 *
 *   node dist/cli/audit-anchor.js heads               print the current heads (JSON lines)
 *   node dist/cli/audit-anchor.js verify [--dir DIR]   check the chain and every anchor in DIR/anchors.jsonl
 *
 * `crapplet-dcim anchor` runs `heads` as the service account and appends the
 * output, as root, to /var/lib/crapplet-dcim-anchors/anchors.jsonl, which the
 * service account cannot change (application code never runs as root). Copy
 * anchors.jsonl off the server too: it is small, and protects against a root
 * compromise.
 */
export interface Anchor {
  at: string;
  orgId: string;
  id: number;
  hash: string;
  count: number;
}

export async function heads(db: Db): Promise<Anchor[]> {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  const out: Anchor[] = [];
  for (const o of orgs) {
    const [last] = await db.select({ id: auditEvents.id, hash: auditEvents.hash }).from(auditEvents).where(eq(auditEvents.orgId, o.id)).orderBy(desc(auditEvents.id)).limit(1);
    if (!last) continue;
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(auditEvents).where(eq(auditEvents.orgId, o.id));
    out.push({ at: new Date().toISOString(), orgId: o.id, id: last.id, hash: last.hash, count: n });
  }
  return out;
}

export function readAnchors(file: string): Anchor[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Anchor);
}

export interface AnchorCheck {
  orgId: string;
  chain: { ok: boolean; checked: number; brokenAtId: number | null };
  anchors: number;
  problems: string[];
}

/** Verifies each organization's chain, then that every anchored event is still there, unchanged, and not past the end of the log. */
export async function verifyAnchors(db: Db, anchors: Anchor[]): Promise<AnchorCheck[]> {
  const audit = new AuditService(db);
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  const out: AnchorCheck[] = [];
  for (const o of orgs) {
    const mine = anchors.filter((a) => a.orgId === o.id);
    const chain = await audit.verifyChain(o.id);
    const problems: string[] = [];
    if (!chain.ok) problems.push(`hash chain broken at event ${chain.brokenAtId}`);
    const [head] = await db.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.orgId, o.id)).orderBy(desc(auditEvents.id)).limit(1);
    for (const a of mine) {
      const [row] = await db.select({ hash: auditEvents.hash }).from(auditEvents).where(and(eq(auditEvents.orgId, o.id), eq(auditEvents.id, a.id)));
      if (!row) problems.push(`event ${a.id} anchored at ${a.at} is missing${!head || head.id < a.id ? ' (newest events were removed)' : ''}`);
      else if (row.hash !== a.hash) problems.push(`event ${a.id} anchored at ${a.at} has a different hash (log rewritten)`);
    }
    out.push({ orgId: o.id, chain, anchors: mine.length, problems });
  }
  // Anchors for organizations that no longer exist.
  for (const a of anchors) if (!orgs.some((o) => o.id === a.orgId) && !out.some((c) => c.orgId === a.orgId)) out.push({ orgId: a.orgId, chain: { ok: false, checked: 0, brokenAtId: null }, anchors: 1, problems: ['organization anchored but no longer in the database'] });
  return out;
}

if (require.main === module) {
  const mode = process.argv[2];
  const dir = arg('dir') ?? '/var/lib/crapplet-dcim-anchors';
  const file = join(dir, 'anchors.jsonl');
  if (mode !== 'heads' && mode !== 'verify') fail(new Error('Usage: audit-anchor.js heads | verify [--dir DIR]'));
  withDb(async (db) => {
    await db.execute(sql`select 1`);
    if (mode === 'heads') {
      for (const h of await heads(db)) process.stdout.write(`${JSON.stringify(h)}\n`);
      return;
    }
    const checks = await verifyAnchors(db, readAnchors(file));
    let bad = 0;
    for (const c of checks) {
      process.stdout.write(`${c.orgId}: ${c.chain.checked} event(s), ${c.anchors} anchor(s): ${c.problems.length ? c.problems.join('; ') : 'OK'}\n`);
      if (c.problems.length) bad++;
    }
    if (!checks.length) process.stdout.write('No organizations\n');
    process.exitCode = bad ? 2 : 0;
  }).catch(fail);
}
