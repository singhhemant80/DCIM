import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/db';

/**
 * Ports that carry a customer's traffic, each link counted once.
 *
 * When the operator's ports are cabled to the customer's equipment (the
 * customer's uplinks), only those operator-side ports are used: ports between
 * the customer's own devices are internal traffic. Only when no uplink is
 * recorded are the customer's own uncabled ports used instead. This depends on
 * cables being recorded; nothing is inferred.
 */
export const customerBillingPortsSql = (orgId: string, customerId: string) => sql`
  with uplinks as (
    select i.id from interfaces i
      join devices d on d.id = i.device_id
     where i.org_id = ${orgId} and d.customer_id is distinct from ${customerId}
       and exists (select 1 from cable_ends e1 join cable_ends e2 on e2.cable_id = e1.cable_id and e2.interface_id <> e1.interface_id
                     join interfaces ci on ci.id = e2.interface_id join devices cd on cd.id = ci.device_id
                    where e1.interface_id = i.id and cd.customer_id = ${customerId}))
  select id from uplinks
  union all
  select i.id from interfaces i
    join devices d on d.id = i.device_id
   where i.org_id = ${orgId} and d.customer_id = ${customerId} and not exists (select 1 from uplinks)
     and not exists (select 1 from cable_ends e where e.interface_id = i.id)`;

/** Which ports a customer's bandwidth figure is based on. */
export const billingBasisSql = (orgId: string, customerId: string) => sql`
  select case when exists (select 1 from interfaces i join devices d on d.id = i.device_id
                             where i.org_id = ${orgId} and d.customer_id is distinct from ${customerId}
                               and exists (select 1 from cable_ends e1 join cable_ends e2 on e2.cable_id = e1.cable_id and e2.interface_id <> e1.interface_id
                                             join interfaces ci on ci.id = e2.interface_id join devices cd on cd.id = ci.device_id
                                            where e1.interface_id = i.id and cd.customer_id = ${customerId}))
              then 'uplinks' else 'customer_ports' end as basis`;

export interface P95 {
  ports: number;
  /** 5-minute buckets with data, and how many the period has. */
  samples: number;
  expectedSamples: number;
  inP95Bps: number | null;
  outP95Bps: number | null;
  /** The usual billing figure: the higher of the two directions. */
  billableP95Bps: number | null;
  inMaxBps: number | null;
  outMaxBps: number | null;
}

/** Nearest-rank 95th percentile (the convention most transit contracts use). */
export function percentile95(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)]!;
}

/** 95th percentile of the summed 5-minute rates of the given ports over [from, to). Measured data only. */
export async function p95ForPorts(db: DbOrTx, portIdsSql: ReturnType<typeof sql>, from: Date, to: Date): Promise<P95> {
  const r = await db.execute<{ bucket: string; in_bps: number; out_bps: number }>(sql`
    with ports as (${portIdsSql})
    select bucket, sum(in_bps)::float8 as in_bps, sum(out_bps)::float8 as out_bps
      from interface_rates_5m where interface_id in (select id from ports)
       and bucket >= ${from.toISOString()}::timestamptz and bucket < ${to.toISOString()}::timestamptz
     group by bucket order by bucket`);
  const n = await db.execute<{ n: number }>(sql`with ports as (${portIdsSql}) select count(*)::int as n from ports`);
  const ins = r.rows.map((x) => Number(x.in_bps));
  const outs = r.rows.map((x) => Number(x.out_bps));
  const inP = percentile95(ins);
  const outP = percentile95(outs);
  return {
    ports: n.rows[0]?.n ?? 0,
    samples: r.rows.length,
    expectedSamples: Math.max(0, Math.floor((to.getTime() - from.getTime()) / 300_000)),
    inP95Bps: inP,
    outP95Bps: outP,
    billableP95Bps: inP === null || outP === null ? null : Math.max(inP, outP),
    inMaxBps: ins.length ? Math.max(...ins) : null,
    outMaxBps: outs.length ? Math.max(...outs) : null,
  };
}

/** A customer's 95th percentile, with the basis it was computed on ('uplinks' or 'customer_ports'). */
export async function customerP95(db: DbOrTx, orgId: string, customerId: string, from: Date, to: Date): Promise<P95 & { basis: 'uplinks' | 'customer_ports' }> {
  const b = await db.execute<{ basis: 'uplinks' | 'customer_ports' }>(billingBasisSql(orgId, customerId));
  return { ...(await p95ForPorts(db, customerBillingPortsSql(orgId, customerId), from, to)), basis: b.rows[0]!.basis };
}
