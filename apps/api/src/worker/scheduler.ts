import { sql } from 'drizzle-orm';
import type { Db } from '../db/db';
import { AuditService } from '../audit/audit.service';
import { STALE_RUN_MS } from '../network/discovery/discovery.service';

/**
 * Starts scheduled discoveries that are due. Called every minute by the
 * worker. Due credentials are claimed with FOR UPDATE SKIP LOCKED and their
 * next run time is moved forward in the same transaction, so two workers (or
 * an overlapping tick) never start the same schedule twice; the partial
 * unique index on discovery_runs still allows only one active run per device.
 * Scheduled runs produce previews only; nothing is applied automatically.
 */
export async function runDueSchedules(db: Db, enqueue: (runId: string) => Promise<void>, limit = 50): Promise<string[]> {
  const audit = new AuditService(db);
  const created = await db.transaction(async (tx) => {
    const due = await tx.execute(sql`
      select c.id, c.org_id, c.device_id, c.kind, c.schedule_hours
      from device_credentials c join devices d on d.id = c.device_id
      where c.schedule_hours is not null and c.next_run_at <= now() and c.host is not null and d.lifecycle_state <> 'retired'
      order by c.next_run_at
      limit ${limit}
      for update of c skip locked`);
    const ids: string[] = [];
    for (const c of due.rows as { id: string; org_id: string; device_id: string; kind: string; schedule_hours: number }[]) {
      await tx.execute(sql`update device_credentials set next_run_at = now() + make_interval(hours => ${c.schedule_hours}) where id = ${c.id}`);
      // A run lost by a crashed worker must not block the schedule forever.
      await tx.execute(sql`
        update discovery_runs set status = 'failed', finished_at = now(), error = 'Timed out waiting for the discovery worker'
        where device_id = ${c.device_id} and status in ('queued', 'running') and created_at < now() - make_interval(secs => ${STALE_RUN_MS / 1000})`);
      const ins = await tx.execute(sql`
        insert into discovery_runs (org_id, device_id, credential_kind, mode, trigger, requested_label)
        values (${c.org_id}, ${c.device_id}, ${c.kind}::credential_kind, 'discover', 'schedule', ${`Scheduled (every ${c.schedule_hours} h)`})
        on conflict do nothing
        returning id`);
      const runId = (ins.rows[0] as { id?: string } | undefined)?.id;
      if (!runId) continue; // a run is already active for this device
      await audit.record({ orgId: c.org_id, actor: { type: 'system', label: 'discovery scheduler' }, action: 'discovery.scheduled', target: { type: 'device', id: c.device_id }, outcome: 'success', meta: { ip: null, userAgent: null, requestId: null }, metadata: { kind: c.kind, runId } }, tx);
      ids.push(runId);
    }
    return ids;
  });
  for (const id of created) {
    try {
      await enqueue(id);
    } catch {
      await db.execute(sql`update discovery_runs set status = 'failed', finished_at = now(), error = 'The job queue (Redis) is unavailable' where id = ${id} and status = 'queued'`);
    }
  }
  return created;
}
