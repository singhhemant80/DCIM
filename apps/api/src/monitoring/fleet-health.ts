import { sql } from 'drizzle-orm';
import type { Db } from '../db/db';
import { SERVER_ROLLUP_LABELS, type ServerHealth, type ServerRollupKey } from '@crapplet/shared';
import { CHECKED_STATES } from '../dcim/reachability';

/**
 * One health view of every device in service: ping (management / BMC address
 * and the server's own address), polled health (CPU, memory, disk,
 * temperature), the BMC's hardware health (PSUs, fans, temperatures, drives,
 * memory, CPUs, controllers) and firing alerts, combined into one status with
 * the reasons. Everything shown is measured; a device nobody checks is
 * "unknown", never "ok".
 */
export type FleetStatus = 'critical' | 'warning' | 'ok' | 'unknown';
export interface FleetReason {
  level: 'critical' | 'warning';
  text: string;
}

const HW_PARTS = sql`(values ('PSU', 'psus'), ('Fan', 'fans'), ('Temperature', 'temperatures'), ('Drive', 'drives'), ('Memory', 'memory'), ('CPU', 'processors'), ('Controller', 'controllers'), ('Volume', 'volumes')) k(part, key)`;

export async function fleetHealth(db: Db, orgId: string) {
  const states = sql.join(
    CHECKED_STATES.map((s) => sql`${s}`),
    sql`, `,
  );
  const r = await db.execute<Record<string, unknown>>(sql`
    select d.id, coalesce(d.hostname, d.asset_tag) as name, d.asset_tag, d.category, d.lifecycle_state, d.mgmt_address, d.customer_id, c.name as customer_name,
           r.name as rack_name, d.position_u, b.name as building_name,
           pm.reachable as mgmt_up, pm.rtt_ms as mgmt_rtt, pm.target as mgmt_target, pm.changed_at as mgmt_changed, pm.checked_at as mgmt_checked,
           ps.reachable as os_up, ps.rtt_ms as os_rtt, ps.target as os_target, ps.changed_at as os_changed, ps.checked_at as os_checked,
           m.enabled as polling, m.last_ok_at, m.last_error as poll_error,
           h.at as health_at, h.cpu_pct, h.memory_used_bytes, h.memory_total_bytes, h.disk_used_bytes, h.disk_total_bytes, h.temperature_c, h.uptime_seconds, h.last_error as health_error,
           hw.fetched_at as hw_at, hw.status as hw_job, hw.last_error as hw_error,
           sh.at as sh_at, sh.data as sh_data, sh.last_error as sh_error, sh.last_attempt_at as sh_attempt,
           hw.inventory->'system'->>'health' as hw_health, hw.inventory->'system'->>'powerState' as power_state,
           (select count(*) from jsonb_array_elements(coalesce(hw.inventory->'psus', '[]'::jsonb)))::int as psu_count,
           (select max((e->>'celsius')::float8) from jsonb_array_elements(coalesce(hw.inventory->'temperatures', '[]'::jsonb)) e where jsonb_typeof(e->'celsius') = 'number') as hw_max_temp,
           (select coalesce(jsonb_agg(jsonb_build_object('part', k.part, 'name', coalesce(e->>'name', e->>'slot', e->>'socket', k.part), 'health', e->>'health')), '[]'::jsonb)
              from ${HW_PARTS}, jsonb_array_elements(coalesce(hw.inventory->k.key, '[]'::jsonb)) e
             where e->>'health' in ('Warning', 'Critical')) as hw_problems,
           (select coalesce(jsonb_agg(jsonb_build_object('severity', a.severity, 'message', a.message, 'since', a.started_at) order by a.severity desc, a.started_at), '[]'::jsonb)
              from alerts a where a.device_id = d.id and a.status = 'firing') as alerts
      from devices d
      left join customers c on c.id = d.customer_id
      left join racks r on r.id = d.rack_id left join rooms rm on rm.id = r.room_id left join buildings b on b.id = rm.building_id
      left join device_reachability pm on pm.device_id = d.id and pm.kind = 'mgmt'
      left join device_reachability ps on ps.device_id = d.id and ps.kind = 'server'
      left join device_monitoring m on m.device_id = d.id
      left join device_health h on h.device_id = d.id
      left join device_hardware hw on hw.device_id = d.id
      left join server_health sh on sh.device_id = d.id
     where d.org_id = ${orgId} and d.lifecycle_state in (${states}) and d.category not in ('patch_panel')
     order by name`);

  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const pct = (u: unknown, t: unknown) => (u !== null && u !== undefined && t ? (Number(u) / Number(t)) * 100 : null);
  const items = r.rows.map((x) => {
    const reasons: FleetReason[] = [];
    const crit = (text: string) => reasons.push({ level: 'critical', text });
    const warn = (text: string) => reasons.push({ level: 'warning', text });
    let signals = 0;

    // Ping.
    const isServer = ['server', 'gpu_server', 'storage'].includes(String(x.category));
    if (x.mgmt_up !== null) {
      signals++;
      if (!x.mgmt_up) crit(`${isServer ? 'BMC' : 'Management address'} ${String(x.mgmt_target)} not answering ping`);
    }
    if (x.os_up !== null) {
      signals++;
      if (!x.os_up) crit(`Server address ${String(x.os_target)} not answering ping`);
    }

    // Polled health (network devices, servers with an SNMP / API credential).
    const healthAt = x.health_at ? new Date(String(x.health_at)) : null;
    const fresh = !!healthAt && Date.now() - healthAt.getTime() < 5 * 60_000;
    const cpu = num(x.cpu_pct);
    const mem = pct(x.memory_used_bytes, x.memory_total_bytes);
    const disk = pct(x.disk_used_bytes, x.disk_total_bytes);
    const temp = num(x.temperature_c);
    if (x.polling) {
      signals++;
      if (x.poll_error) warn(`Polling failed: ${String(x.poll_error)}`);
      else if (healthAt && !fresh) warn(`Health last read ${Math.round((Date.now() - healthAt.getTime()) / 60_000)} min ago`);
    }
    if (fresh) {
      if (cpu !== null && cpu >= 90) crit(`CPU ${cpu.toFixed(0)}%`);
      else if (cpu !== null && cpu >= 75) warn(`CPU ${cpu.toFixed(0)}%`);
      if (mem !== null && mem >= 90) crit(`Memory ${mem.toFixed(0)}%`);
      else if (mem !== null && mem >= 75) warn(`Memory ${mem.toFixed(0)}%`);
      if (disk !== null && disk >= 90) warn(`Storage ${disk.toFixed(0)}% full`);
      if (temp !== null && temp >= 85) crit(`${temp.toFixed(0)} °C`);
      else if (temp !== null && temp >= 70) warn(`${temp.toFixed(0)} °C`);
    }

    // Current health from the BMC (every 5 minutes): component rollups, temperatures, usage.
    const shAt = x.sh_at ? new Date(String(x.sh_at)) : null;
    const sh = (x.sh_data as ServerHealth | null) ?? null;
    const shFresh = !!sh && !!shAt && Date.now() - shAt.getTime() < 15 * 60_000;
    const rollup = shFresh ? sh!.rollup : {};
    if (shFresh) {
      signals++;
      const parts = Object.entries(rollup).filter(([k, h]) => k !== 'system' && (h === 'Warning' || h === 'Critical')) as [ServerRollupKey, string][];
      for (const [k, h] of parts) (h === 'Critical' ? crit : warn)(`${SERVER_ROLLUP_LABELS[k]}: ${h} (BMC)`);
      if (!parts.length && (rollup.system === 'Critical' || rollup.system === 'Warning')) (rollup.system === 'Critical' ? crit : warn)(`BMC reports the system ${rollup.system}`);
      const u = sh!;
      if (u.cpuUsagePct !== null && u.cpuUsagePct >= 90) crit(`CPU usage ${u.cpuUsagePct.toFixed(0)}% (BMC)`);
      else if (u.cpuUsagePct !== null && u.cpuUsagePct >= 75) warn(`CPU usage ${u.cpuUsagePct.toFixed(0)}% (BMC)`);
      if (u.memoryUsagePct !== null && u.memoryUsagePct >= 90) warn(`Memory usage ${u.memoryUsagePct.toFixed(0)}% (BMC)`);
      if (u.inletC !== null && u.inletC >= 35) warn(`Inlet ${u.inletC.toFixed(0)} °C`);
    } else if (x.sh_error && x.sh_attempt) warn(`BMC health read failed: ${String(x.sh_error)}`);

    // Hardware from the BMC's daily walk (servers): per part. With a fresh rollup, only parts of components it doesn't call OK.
    const hwHealth = (x.hw_health as string | null) ?? null;
    const PART_KEY: Record<string, ServerRollupKey> = { PSU: 'psu', Fan: 'fans', Temperature: 'temperature', Drive: 'storage', Controller: 'storage', Volume: 'storage', Memory: 'memory', CPU: 'cpu' };
    const hwProblems = ((x.hw_problems as { part: string; name: string; health: string }[]) ?? []).filter((pb) => !shFresh || rollup[PART_KEY[pb.part] ?? 'system'] !== 'OK');
    if (x.hw_at) {
      if (!shFresh) signals++;
      for (const pb of hwProblems) (pb.health === 'Critical' ? crit : warn)(`${pb.part} ${pb.name}: ${pb.health}`);
      if (!shFresh && hwHealth === 'Critical' && !hwProblems.some((pb) => pb.health === 'Critical')) crit('BMC reports the system Critical');
      else if (!shFresh && hwHealth === 'Warning' && !hwProblems.length) warn('BMC reports the system Warning');
    }
    if (x.hw_error && x.hw_job === 'failed' && !shFresh) warn(`BMC read failed: ${String(x.hw_error)}`);

    // Alerts.
    const alerts = (x.alerts as { severity: string; message: string; since: string }[]) ?? [];
    for (const a of alerts) if (a.severity !== 'info') (a.severity === 'critical' ? crit : warn)(a.message);

    const status: FleetStatus = reasons.some((y) => y.level === 'critical') ? 'critical' : reasons.length ? 'warning' : signals ? 'ok' : 'unknown';
    return {
      id: x.id as string,
      name: x.name as string,
      assetTag: x.asset_tag as string,
      category: x.category as string,
      lifecycleState: x.lifecycle_state as string,
      customerId: (x.customer_id as string | null) ?? null,
      customerName: (x.customer_name as string | null) ?? null,
      location: [x.building_name, x.rack_name && `${String(x.rack_name)}${x.position_u ? ` U${String(x.position_u)}` : ''}`].filter(Boolean).join(' · ') || null,
      status,
      reasons,
      ping: {
        mgmt: x.mgmt_up === null ? null : { up: !!x.mgmt_up, rttMs: num(x.mgmt_rtt), target: x.mgmt_target as string, since: x.mgmt_changed as string, checkedAt: x.mgmt_checked as string },
        server: x.os_up === null ? null : { up: !!x.os_up, rttMs: num(x.os_rtt), target: x.os_target as string, since: x.os_changed as string, checkedAt: x.os_checked as string },
      },
      metrics:
        x.polling || healthAt
          ? {
              at: healthAt?.toISOString() ?? null,
              fresh,
              cpuPct: cpu,
              memoryPct: mem,
              diskPct: disk,
              temperatureC: temp,
              uptimeSeconds: num(x.uptime_seconds),
              error: (x.poll_error as string | null) ?? (x.health_error as string | null) ?? null,
            }
          : null,
      hardware:
        x.hw_at || x.hw_error
          ? {
              at: (x.hw_at as string | null) ?? null,
              health: hwHealth,
              powerState: (x.power_state as string | null) ?? null,
              psuCount: num(x.psu_count),
              maxTempC: num(x.hw_max_temp),
              problems: hwProblems,
              error: x.hw_job === 'failed' ? ((x.hw_error as string | null) ?? null) : null,
            }
          : null,
      /** Current health from the BMC (servers, every 5 minutes). */
      bmc: sh || x.sh_error ? { at: shAt?.toISOString() ?? null, fresh: shFresh, ...(sh ?? {}), error: (x.sh_error as string | null) ?? null } : null,
      alerts: alerts.length,
    };
  });
  const rank: Record<FleetStatus, number> = { critical: 0, warning: 1, unknown: 2, ok: 3 };
  items.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const count = (s: FleetStatus) => items.filter((i) => i.status === s).length;
  return { at: new Date().toISOString(), totals: { all: items.length, critical: count('critical'), warning: count('warning'), ok: count('ok'), unknown: count('unknown') }, items };
}
