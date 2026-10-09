import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/db';
import { buildings, customers, datacenters, devices, interfaces, racks, rooms, vlans, vrfs } from '../db/schema';
import type { Principal } from '../auth/principal';

/**
 * Ownership checks shared by the network and IPAM services. Every id that
 * arrives in a request body is resolved inside the caller's organization;
 * an id from another organization behaves exactly like a missing one.
 */
export async function ownDevice(db: DbOrTx, p: Principal, id: string, what = 'Device') {
  const [d] = await db.select().from(devices).where(and(eq(devices.id, id), eq(devices.orgId, p.orgId)));
  if (!d) throw new BadRequestException({ error: 'invalid_device', message: `${what} does not exist` });
  return d;
}

export async function ownInterface(db: DbOrTx, p: Principal, id: string) {
  const [i] = await db.select().from(interfaces).where(and(eq(interfaces.id, id), eq(interfaces.orgId, p.orgId)));
  if (!i) throw new BadRequestException({ error: 'invalid_interface', message: 'Interface does not exist' });
  return i;
}

export async function ownCustomer(db: DbOrTx, p: Principal, id: string | null | undefined) {
  if (!id) return;
  const [c] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, id), eq(customers.orgId, p.orgId)));
  if (!c) throw new BadRequestException({ error: 'invalid_customer', message: 'Customer does not exist' });
}

export async function ownDatacenter(db: DbOrTx, p: Principal, id: string | null | undefined) {
  if (!id) return;
  const [d] = await db.select({ id: datacenters.id }).from(datacenters).where(and(eq(datacenters.id, id), eq(datacenters.orgId, p.orgId)));
  if (!d) throw new BadRequestException({ error: 'invalid_datacenter', message: 'Datacenter does not exist' });
}

export async function ownVrf(db: DbOrTx, p: Principal, id: string | null | undefined) {
  if (!id) return null;
  const [v] = await db.select().from(vrfs).where(and(eq(vrfs.id, id), eq(vrfs.orgId, p.orgId)));
  if (!v) throw new BadRequestException({ error: 'invalid_vrf', message: 'VRF does not exist' });
  return v;
}

export async function ownVlans(db: DbOrTx, p: Principal, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db.select().from(vlans).where(and(eq(vlans.orgId, p.orgId), inArray(vlans.id, unique)));
  if (rows.length !== unique.length) throw new BadRequestException({ error: 'invalid_vlan', message: 'One or more VLANs do not exist' });
  return rows;
}

/** Datacenter a device is installed in (through its rack), or null when not racked. */
export async function deviceDatacenterId(db: DbOrTx, deviceId: string): Promise<string | null> {
  const [row] = await db
    .select({ dc: buildings.datacenterId })
    .from(devices)
    .innerJoin(racks, eq(racks.id, devices.rackId))
    .innerJoin(rooms, eq(rooms.id, racks.roomId))
    .innerJoin(buildings, eq(buildings.id, rooms.buildingId))
    .where(eq(devices.id, deviceId));
  return row?.dc ?? null;
}

export function notFound(what: string) {
  return new NotFoundException({ error: 'not_found', message: `${what} not found` });
}

/** Escapes LIKE wildcards in user search text. */
export function like(q: string) {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export const ZERO_UUID = sql.raw(`'00000000-0000-0000-0000-000000000000'::uuid`);
