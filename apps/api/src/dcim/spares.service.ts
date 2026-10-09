import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { sparePartAdjustSchema, sparePartSchema } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { datacenters, devices, sparePartMovements, spareParts } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowDbError } from '../common/pg-errors';
import type { Principal, RequestMeta } from '../auth/principal';

type PartInput = z.infer<typeof sparePartSchema>;

/**
 * Spare-parts stock. Quantity only changes through `adjust`, which is a single
 * atomic UPDATE guarded by a CHECK (quantity >= 0), so concurrent withdrawals
 * can never drive stock negative; every change is logged as a movement.
 */
@Injectable()
export class SparesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(p: Principal, q: { kind?: string; datacenterId?: string; lowStock?: string; q?: string }) {
    const conds: SQL[] = [eq(spareParts.orgId, p.orgId)];
    if (q.kind) conds.push(sql`${spareParts.kind} = ${q.kind}`);
    if (q.datacenterId) conds.push(eq(spareParts.datacenterId, q.datacenterId));
    if (q.lowStock === 'true') conds.push(sql`${spareParts.quantity} <= ${spareParts.minQuantity}`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      conds.push(or(ilike(spareParts.partNumber, like), ilike(spareParts.description, like), ilike(spareParts.manufacturer, like))!);
    }
    const rows = await this.db
      .select({ part: spareParts, datacenterCode: datacenters.code })
      .from(spareParts)
      .leftJoin(datacenters, eq(datacenters.id, spareParts.datacenterId))
      .where(and(...conds))
      .orderBy(asc(spareParts.kind), asc(spareParts.partNumber));
    return rows.map((r) => this.view(r.part, r.datacenterCode));
  }

  private view(part: typeof spareParts.$inferSelect, datacenterCode: string | null) {
    return { ...part, unitCost: part.unitCost === null ? null : Number(part.unitCost), datacenterCode, lowStock: part.quantity <= part.minQuantity };
  }

  private async own(p: Principal, id: string) {
    const [part] = await this.db.select().from(spareParts).where(and(eq(spareParts.id, id), eq(spareParts.orgId, p.orgId)));
    if (!part) throw new NotFoundException({ error: 'not_found', message: 'Spare part not found' });
    return part;
  }

  async create(p: Principal, input: PartInput, meta: RequestMeta) {
    await this.checkDc(p, input.datacenterId);
    try {
      return await this.db.transaction(async (tx) => {
        const [part] = await tx.insert(spareParts).values({ ...this.cols(input), quantity: input.quantity, orgId: p.orgId }).returning();
        if (input.quantity > 0) {
          await tx.insert(sparePartMovements).values({ orgId: p.orgId, partId: part!.id, delta: input.quantity, quantityAfter: input.quantity, reason: 'Initial stock', actorId: p.userId, actorLabel: p.email });
        }
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'spare_part.create', target: { type: 'spare_part', id: part!.id }, outcome: 'success', meta, metadata: { partNumber: part!.partNumber, quantity: part!.quantity } }, tx);
        return this.view(part!, null);
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  /** Edits descriptive fields. Quantity is ignored here; use adjust() so every change is logged. */
  async update(p: Principal, id: string, input: PartInput, meta: RequestMeta) {
    await this.own(p, id);
    await this.checkDc(p, input.datacenterId);
    try {
      return await this.db.transaction(async (tx) => {
        const [part] = await tx.update(spareParts).set(this.cols(input)).where(eq(spareParts.id, id)).returning();
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'spare_part.update', target: { type: 'spare_part', id }, outcome: 'success', meta }, tx);
        return this.view(part!, null);
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async remove(p: Principal, id: string, meta: RequestMeta) {
    const part = await this.own(p, id);
    if (part.quantity > 0) throw new BadRequestException({ error: 'stock_remaining', message: `${part.quantity} in stock; adjust the quantity to zero first` });
    await this.db.transaction(async (tx) => {
      await tx.delete(spareParts).where(eq(spareParts.id, id));
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'spare_part.delete', target: { type: 'spare_part', id }, outcome: 'success', meta, metadata: { partNumber: part.partNumber } }, tx);
    });
  }

  async adjust(p: Principal, id: string, input: z.infer<typeof sparePartAdjustSchema>, meta: RequestMeta) {
    await this.own(p, id);
    if (input.deviceId) {
      const [d] = await this.db.select({ id: devices.id }).from(devices).where(and(eq(devices.id, input.deviceId), eq(devices.orgId, p.orgId)));
      if (!d) throw new BadRequestException({ error: 'invalid_device', message: 'Device does not exist' });
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [part] = await tx
          .update(spareParts)
          .set({ quantity: sql`${spareParts.quantity} + ${input.delta}` })
          .where(eq(spareParts.id, id))
          .returning();
        await tx.insert(sparePartMovements).values({ orgId: p.orgId, partId: id, delta: input.delta, quantityAfter: part!.quantity, reason: input.reason, deviceId: input.deviceId ?? null, actorId: p.userId, actorLabel: p.email });
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'spare_part.adjust', target: { type: 'spare_part', id }, outcome: 'success', meta, metadata: { delta: input.delta, quantityAfter: part!.quantity, reason: input.reason } }, tx);
        return this.view(part!, null);
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async movements(p: Principal, id: string) {
    await this.own(p, id);
    return this.db
      .select({ m: sparePartMovements, deviceAssetTag: devices.assetTag })
      .from(sparePartMovements)
      .leftJoin(devices, eq(devices.id, sparePartMovements.deviceId))
      .where(eq(sparePartMovements.partId, id))
      .orderBy(desc(sparePartMovements.id))
      .limit(200)
      .then((rows) => rows.map((r) => ({ ...r.m, deviceAssetTag: r.deviceAssetTag })));
  }

  private cols(i: PartInput) {
    return {
      datacenterId: i.datacenterId ?? null,
      kind: i.kind,
      manufacturer: i.manufacturer ?? null,
      partNumber: i.partNumber,
      description: i.description,
      minQuantity: i.minQuantity,
      location: i.location ?? null,
      unitCost: i.unitCost == null ? null : String(i.unitCost),
      notes: i.notes ?? null,
    };
  }

  private async checkDc(p: Principal, id: string | null | undefined) {
    if (!id) return;
    const [dc] = await this.db.select({ id: datacenters.id }).from(datacenters).where(and(eq(datacenters.id, id), eq(datacenters.orgId, p.orgId)));
    if (!dc) throw new BadRequestException({ error: 'invalid_datacenter', message: 'Datacenter does not exist' });
  }
}
