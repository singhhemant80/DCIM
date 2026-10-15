import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { ACCESSORY_LABELS, type AccessoryInput, type DevicePhotoInput, type HardwareInventory, type hardwareApplySchema } from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { deviceAccessories, deviceCredentials, deviceEvents, deviceHardware, devicePhotos, devices, sparePartMovements, spareParts, type Device } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import type { Principal, RequestMeta } from '../auth/principal';

const NOT_FOUND = () => new NotFoundException({ error: 'not_found', message: 'Device not found' });

/** "12 × 32 GB DDR4 3200 MHz" (grouped by identical modules). */
export function dimmLayout(inv: HardwareInventory): string | null {
  const groups = new Map<string, number>();
  for (const m of inv.memory) {
    const key = [m.sizeGb ? `${m.sizeGb} GB` : null, m.type, m.speedMhz ? `${m.speedMhz} MHz` : null].filter(Boolean).join(' ');
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const s = [...groups.entries()].map(([k, c]) => `${c} × ${k}`).join(', ');
  return s ? s.slice(0, 500) : null;
}

const speed = (mbps: number | null) => (mbps ? (mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`) : null);
const MAC = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

/** The device-record fields a hardware inventory fills, per apply option. */
export function recordFromInventory(inv: HardwareInventory, fields: readonly string[]): Partial<Device> {
  const set: Partial<Device> = {};
  if (fields.includes('serial')) {
    // Dell: the service tag is the SKU; other vendors put it in SerialNumber.
    const serial = /dell/i.test(inv.system.manufacturer ?? '') ? (inv.system.sku ?? inv.system.serial) : (inv.system.serial ?? inv.system.sku);
    if (serial) set.serial = serial.slice(0, 120);
  }
  if (fields.includes('cpu')) {
    const model = inv.processors[0]?.model ?? inv.system.cpuModel;
    if (model) set.cpu = model.slice(0, 200);
    const count = inv.processors.length || inv.system.cpuCount;
    if (count) set.cpuCount = Math.min(64, count);
  }
  if (fields.includes('ram')) {
    const total = inv.memory.reduce((a, m) => a + (m.sizeGb ?? 0), 0) || inv.system.memoryGb;
    if (total) set.ramGb = Math.round(total);
    const layout = dimmLayout(inv);
    if (layout) set.dimmLayout = layout;
  }
  if (fields.includes('disks') && inv.drives.length) {
    set.disks = inv.drives.slice(0, 64).map((d) => ({
      slot: (d.slot ?? d.name).slice(0, 20),
      type: (d.protocol === 'NVMe' ? 'NVMe' : (d.mediaType ?? d.protocol ?? 'Disk')).slice(0, 20),
      sizeGb: Math.round(d.capacityGb ?? 0),
      model: d.model?.slice(0, 80) ?? null,
    }));
  }
  if (fields.includes('nics') && inv.nics.length) {
    set.nics = inv.nics.slice(0, 32).map((x) => ({ name: x.name.slice(0, 40), mac: x.mac && MAC.test(x.mac) ? x.mac : null, speed: speed(x.speedMbps) }));
  }
  if (fields.includes('firmware')) {
    if (inv.system.biosVersion) set.biosVersion = inv.system.biosVersion.slice(0, 60);
    if (inv.bmc?.firmware) set.bmcFirmware = inv.bmc.firmware.slice(0, 60);
  }
  return set;
}

/**
 * Hardware read from a server's BMC, and the accessories fitted with a
 * device. The API never talks to the BMC: a refresh only marks the device
 * so the worker reads it (read-only) on its next pass.
 */
@Injectable()
export class HardwareService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Staff: any device of the organization. Customers: their own equipment, read-only. */
  private async device(p: Principal, id: string, write = false): Promise<Device> {
    const [d] = await this.db.select().from(devices).where(and(eq(devices.id, id), eq(devices.orgId, p.orgId)));
    if (!d) throw NOT_FOUND();
    if (p.userType !== 'staff') {
      if (!p.customerId || d.customerId !== p.customerId) throw NOT_FOUND();
      if (write) throw new ForbiddenException({ error: 'forbidden', message: 'Ask the datacenter team to change this' });
    }
    return d;
  }

  private async event(tx: DbOrTx, p: Principal, deviceId: string, kind: string, summary: string, data: Record<string, unknown> = {}) {
    await tx.insert(deviceEvents).values({ orgId: p.orgId, deviceId, kind, summary, data, actorId: p.userId, actorLabel: p.email });
  }

  /* ---------------------------------------------------------------- hardware */

  async hardware(p: Principal, id: string) {
    const d = await this.device(p, id);
    const [h] = await this.db.select().from(deviceHardware).where(eq(deviceHardware.deviceId, id));
    const [cred] = await this.db.select({ id: deviceCredentials.id }).from(deviceCredentials).where(and(eq(deviceCredentials.deviceId, id), eq(deviceCredentials.kind, 'redfish')));
    const inv = h?.inventory ?? null;
    return {
      deviceId: d.id,
      hasRedfish: !!cred,
      status: h?.status ?? (cred ? 'pending' : 'not_configured'),
      requestedAt: h?.requestedAt ?? null,
      fetchedAt: h?.fetchedAt ?? null,
      nextAt: h?.nextAt ?? null,
      lastError: h?.lastError ?? null,
      health: h?.health ?? null,
      // Customers see everything about their own server, including its event log; collection warnings are staff-only.
      inventory: inv && p.userType !== 'staff' ? { ...inv, warnings: [] } : inv,
      /** What "copy to record" would change, field by field. */
      differences: inv && p.userType === 'staff' ? this.differences(d, inv) : [],
    };
  }

  private differences(d: Device, inv: HardwareInventory) {
    const next = recordFromInventory(inv, ['serial', 'cpu', 'ram', 'disks', 'nics', 'firmware']);
    const fieldOf: Record<string, string> = { serial: 'serial', cpu: 'cpu', cpuCount: 'cpu', ramGb: 'ram', dimmLayout: 'ram', disks: 'disks', nics: 'nics', biosVersion: 'firmware', bmcFirmware: 'firmware' };
    const out: { field: string; key: string; current: unknown; fromBmc: unknown }[] = [];
    for (const [k, v] of Object.entries(next)) {
      const cur = (d as Record<string, unknown>)[k] ?? null;
      if (JSON.stringify(cur) !== JSON.stringify(v)) out.push({ field: fieldOf[k] ?? k, key: k, current: cur, fromBmc: v });
    }
    return out;
  }

  async refresh(p: Principal, id: string, meta: RequestMeta) {
    await this.device(p, id, true);
    const [cred] = await this.db.select({ id: deviceCredentials.id }).from(deviceCredentials).where(and(eq(deviceCredentials.deviceId, id), eq(deviceCredentials.kind, 'redfish')));
    if (!cred) throw new BadRequestException({ error: 'no_redfish', message: 'Add a Redfish (iDRAC, iLO, XClarity) credential to this device first' });
    await this.db
      .insert(deviceHardware)
      .values({ deviceId: id, orgId: p.orgId, requestedAt: new Date(), requestedBy: p.email })
      .onConflictDoUpdate({ target: deviceHardware.deviceId, set: { requestedAt: new Date(), requestedBy: p.email } });
    await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'device.hardware.refresh', target: { type: 'device', id }, outcome: 'success', meta });
    return { queued: true };
  }

  async apply(p: Principal, id: string, input: z.infer<typeof hardwareApplySchema>, meta: RequestMeta) {
    const d = await this.device(p, id, true);
    const [h] = await this.db.select().from(deviceHardware).where(eq(deviceHardware.deviceId, id));
    if (!h?.inventory) throw new BadRequestException({ error: 'no_inventory', message: 'Nothing has been read from the BMC yet' });
    const set = recordFromInventory(h.inventory, input.fields);
    if (!Object.keys(set).length) return { changed: [] };
    const changed = Object.keys(set).filter((k) => JSON.stringify((d as Record<string, unknown>)[k] ?? null) !== JSON.stringify((set as Record<string, unknown>)[k]));
    if (!changed.length) return { changed: [] };
    try {
      await this.db.transaction(async (tx) => {
        await tx.update(devices).set({ ...set, updatedAt: new Date() }).where(eq(devices.id, id));
        await this.event(tx, p, id, 'hardware_applied', `Record updated from the BMC: ${changed.join(', ')}`, { fields: changed, fetchedAt: h.fetchedAt });
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'device.hardware.apply', target: { type: 'device', id }, outcome: 'success', meta, metadata: { fields: changed } }, tx);
      });
    } catch (e) {
      if (((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code) === '23505') throw new BadRequestException({ error: 'serial_taken', message: 'Another device already has this serial number' });
      throw e;
    }
    return { changed };
  }

  /* ---------------------------------------------------------------- accessories */

  async accessories(p: Principal, id: string) {
    await this.device(p, id);
    return this.db
      .select({ a: deviceAccessories, sparePartNumber: spareParts.partNumber })
      .from(deviceAccessories)
      .leftJoin(spareParts, eq(spareParts.id, deviceAccessories.sparePartId))
      .where(and(eq(deviceAccessories.deviceId, id), eq(deviceAccessories.orgId, p.orgId)))
      .orderBy(asc(deviceAccessories.kind), asc(deviceAccessories.createdAt))
      .then((rows) => rows.map(({ a, sparePartNumber }) => ({ ...a, lengthM: a.lengthM === null ? null : Number(a.lengthM), sparePartNumber })));
  }

  /** Takes `qty` from a stock line (refused when there isn't enough), recording the movement. */
  private async takeStock(tx: DbOrTx, p: Principal, partId: string, qty: number, deviceId: string, reason: string) {
    const [part] = await tx
      .update(spareParts)
      .set({ quantity: sql`${spareParts.quantity} - ${qty}`, updatedAt: new Date() })
      .where(and(eq(spareParts.id, partId), eq(spareParts.orgId, p.orgId), sql`${spareParts.quantity} >= ${qty}`))
      .returning();
    if (!part) {
      const [exists] = await tx.select({ q: spareParts.quantity }).from(spareParts).where(and(eq(spareParts.id, partId), eq(spareParts.orgId, p.orgId)));
      throw new BadRequestException(exists ? { error: 'not_enough_stock', message: `Only ${exists.q} in stock` } : { error: 'invalid_part', message: 'Spare part not found' });
    }
    await tx.insert(sparePartMovements).values({ orgId: p.orgId, partId, delta: -qty, quantityAfter: part.quantity, reason, deviceId, actorId: p.userId, actorLabel: p.email });
  }

  private async returnStock(tx: DbOrTx, p: Principal, partId: string, qty: number, deviceId: string, reason: string) {
    const [part] = await tx
      .update(spareParts)
      .set({ quantity: sql`${spareParts.quantity} + ${qty}`, updatedAt: new Date() })
      .where(and(eq(spareParts.id, partId), eq(spareParts.orgId, p.orgId)))
      .returning();
    if (part) await tx.insert(sparePartMovements).values({ orgId: p.orgId, partId, delta: qty, quantityAfter: part.quantity, reason, deviceId, actorId: p.userId, actorLabel: p.email });
  }

  private values(i: AccessoryInput) {
    return {
      kind: i.kind,
      quantity: i.quantity,
      description: i.description ?? null,
      lengthM: i.lengthM === null || i.lengthM === undefined ? null : String(i.lengthM),
      partNumber: i.partNumber ?? null,
      serial: i.serial ?? null,
      notes: i.notes ?? null,
    };
  }

  private label(i: { kind: string; quantity: number; description?: string | null }) {
    return `${i.quantity} × ${ACCESSORY_LABELS[i.kind as keyof typeof ACCESSORY_LABELS] ?? i.kind}${i.description ? ` (${i.description})` : ''}`;
  }

  /* ---------------------------------------------------------------- front photo */

  async photo(p: Principal, id: string) {
    await this.device(p, id);
    const [row] = await this.db.select().from(devicePhotos).where(eq(devicePhotos.deviceId, id));
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'No photo' });
    return row;
  }

  /** Stores the photo after checking that the bytes really are a JPEG, PNG or WebP image. */
  async putPhoto(p: Principal, id: string, i: DevicePhotoInput, meta: RequestMeta) {
    await this.device(p, id, true);
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(i.image)!;
    const data = Buffer.from(m[2]!, 'base64');
    const type = data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      ? 'image/jpeg'
      : data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        ? 'image/png'
        : data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP'
          ? 'image/webp'
          : null;
    if (!type) throw new BadRequestException({ error: 'invalid_image', message: 'The file is not a JPEG, PNG or WebP image' });
    if (data.length > 1_048_576) throw new BadRequestException({ error: 'too_large', message: 'The photo is too large (at most 1 MB)' });
    await this.db.transaction(async (tx) => {
      const values = { contentType: type, data, size: data.length, uploadedBy: p.email, updatedAt: new Date() };
      await tx.insert(devicePhotos).values({ deviceId: id, orgId: p.orgId, ...values }).onConflictDoUpdate({ target: devicePhotos.deviceId, set: values });
      await this.event(tx, p, id, 'photo', 'Front photo updated', { size: data.length });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'device.photo.put', target: { type: 'device', id }, outcome: 'success', meta, metadata: { contentType: type, size: data.length } }, tx);
    });
    return { hasPhoto: true, photoUpdatedAt: new Date().toISOString() };
  }

  async deletePhoto(p: Principal, id: string, meta: RequestMeta) {
    await this.device(p, id, true);
    await this.db.transaction(async (tx) => {
      const rows = await tx.delete(devicePhotos).where(eq(devicePhotos.deviceId, id)).returning({ id: devicePhotos.deviceId });
      if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'No photo' });
      await this.event(tx, p, id, 'photo', 'Front photo removed');
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'device.photo.delete', target: { type: 'device', id }, outcome: 'success', meta }, tx);
    });
  }

  async addAccessory(p: Principal, id: string, i: AccessoryInput, meta: RequestMeta) {
    const d = await this.device(p, id, true);
    return this.db.transaction(async (tx) => {
      if (i.sparePartId) await this.takeStock(tx, p, i.sparePartId, i.quantity, id, `Fitted to ${d.hostname ?? d.assetTag}`);
      const [row] = await tx.insert(deviceAccessories).values({ ...this.values(i), orgId: p.orgId, deviceId: id, sparePartId: i.sparePartId ?? null }).returning();
      await this.event(tx, p, id, 'accessory_added', `Added ${this.label(i)}${i.sparePartId ? ' from spare stock' : ''}`, { accessoryId: row!.id });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'device.accessory.add', target: { type: 'device', id }, outcome: 'success', meta, metadata: { kind: i.kind, quantity: i.quantity } }, tx);
      return row!;
    });
  }

  async updateAccessory(p: Principal, id: string, accessoryId: string, i: AccessoryInput, meta: RequestMeta) {
    const d = await this.device(p, id, true);
    return this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(deviceAccessories).where(and(eq(deviceAccessories.id, accessoryId), eq(deviceAccessories.deviceId, id))).for('update');
      if (!cur) throw new NotFoundException({ error: 'not_found', message: 'Accessory not found' });
      // Quantity changes on a stock-linked line move stock accordingly; the stock line itself is kept.
      if (cur.sparePartId && i.quantity !== cur.quantity) {
        const diff = i.quantity - cur.quantity;
        if (diff > 0) await this.takeStock(tx, p, cur.sparePartId, diff, id, `Fitted to ${d.hostname ?? d.assetTag}`);
        else await this.returnStock(tx, p, cur.sparePartId, -diff, id, `Returned from ${d.hostname ?? d.assetTag}`);
      }
      const [row] = await tx.update(deviceAccessories).set({ ...this.values(i), updatedAt: new Date() }).where(eq(deviceAccessories.id, accessoryId)).returning();
      await this.event(tx, p, id, 'accessory_changed', `Changed to ${this.label(i)}`, { accessoryId });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'device.accessory.update', target: { type: 'device', id }, outcome: 'success', meta, metadata: { accessoryId } }, tx);
      return row!;
    });
  }

  async removeAccessory(p: Principal, id: string, accessoryId: string, returnToStock: boolean, meta: RequestMeta) {
    const d = await this.device(p, id, true);
    await this.db.transaction(async (tx) => {
      const [cur] = await tx.delete(deviceAccessories).where(and(eq(deviceAccessories.id, accessoryId), eq(deviceAccessories.deviceId, id))).returning();
      if (!cur) throw new NotFoundException({ error: 'not_found', message: 'Accessory not found' });
      if (returnToStock && cur.sparePartId) await this.returnStock(tx, p, cur.sparePartId, cur.quantity, id, `Returned from ${d.hostname ?? d.assetTag}`);
      await this.event(tx, p, id, 'accessory_removed', `Removed ${this.label(cur)}${returnToStock && cur.sparePartId ? ', returned to stock' : ''}`, { accessoryId });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'device.accessory.remove', target: { type: 'device', id }, outcome: 'success', meta, metadata: { accessoryId, returnToStock } }, tx);
    });
  }
}
