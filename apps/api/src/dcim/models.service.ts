import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { deviceModelSchema, manufacturerSchema } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { deviceModels, devices, manufacturers } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowDbError } from '../common/pg-errors';
import type { Principal, RequestMeta } from '../auth/principal';

type ModelInput = z.infer<typeof deviceModelSchema>;

/**
 * Manufacturers and device models (the "type" of a device). A device copies
 * its model's height and depth class when created; changing a model's
 * physical size is refused while devices of that model are racked, because it
 * would silently invalidate their placement.
 */
@Injectable()
export class ModelsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  listManufacturers(p: Principal) {
    return this.db
      .select({ m: manufacturers, models: sql<number>`(select count(*)::int from device_models dm where dm.manufacturer_id = "manufacturers"."id")` })
      .from(manufacturers)
      .where(eq(manufacturers.orgId, p.orgId))
      .orderBy(asc(manufacturers.name))
      .then((rows) => rows.map((r) => ({ ...r.m, modelCount: r.models })));
  }

  async createManufacturer(p: Principal, input: z.infer<typeof manufacturerSchema>, meta: RequestMeta) {
    try {
      return await this.db.transaction(async (tx) => {
        const [m] = await tx.insert(manufacturers).values({ orgId: p.orgId, name: input.name }).returning();
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'manufacturer.create', target: { type: 'manufacturer', id: m!.id }, outcome: 'success', meta, metadata: { name: m!.name } }, tx);
        return m!;
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async listModels(p: Principal) {
    const rows = await this.db
      .select({ model: deviceModels, manufacturerName: manufacturers.name, deviceCount: sql<number>`(select count(*)::int from devices d where d.model_id = "device_models"."id")` })
      .from(deviceModels)
      .innerJoin(manufacturers, eq(manufacturers.id, deviceModels.manufacturerId))
      .where(eq(deviceModels.orgId, p.orgId))
      .orderBy(asc(manufacturers.name), asc(deviceModels.name));
    return rows.map((r) => ({ ...r.model, weightKg: r.model.weightKg === null ? null : Number(r.model.weightKg), manufacturerName: r.manufacturerName, deviceCount: r.deviceCount }));
  }

  async getModel(p: Principal, id: string) {
    const [m] = await this.db.select().from(deviceModels).where(and(eq(deviceModels.id, id), eq(deviceModels.orgId, p.orgId)));
    if (!m) throw new NotFoundException({ error: 'not_found', message: 'Device model not found' });
    return m;
  }

  async createModel(p: Principal, input: ModelInput, meta: RequestMeta) {
    await this.checkManufacturer(p, input.manufacturerId);
    try {
      return await this.db.transaction(async (tx) => {
        const [m] = await tx.insert(deviceModels).values({ ...this.cols(input), orgId: p.orgId }).returning();
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'device_model.create', target: { type: 'device_model', id: m!.id }, outcome: 'success', meta, metadata: { name: m!.name, uHeight: m!.uHeight } }, tx);
        return m!;
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async updateModel(p: Principal, id: string, input: ModelInput, meta: RequestMeta) {
    const before = await this.getModel(p, id);
    await this.checkManufacturer(p, input.manufacturerId);
    const physicalChange = before.uHeight !== input.uHeight || before.fullDepth !== input.fullDepth || before.category !== input.category;
    try {
      return await this.db.transaction(async (tx) => {
        // Lock the model; device creation takes a share lock on it, so no device can appear mid-check.
        await tx.select({ id: deviceModels.id }).from(deviceModels).where(eq(deviceModels.id, id)).for('update');
        if (physicalChange) {
          const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(devices).where(eq(devices.modelId, id));
          if (n > 0) {
            throw new BadRequestException({ error: 'model_in_use', message: `${n} device(s) use this model; height, depth class and category can’t change. Create a new model instead.` });
          }
        }
        // Depth increases are checked against current racks by the devices_rack_fit trigger on the next placement;
        // here we reject a change that would make an already racked device too deep.
        if (input.depthMm != null && (before.depthMm ?? 0) < input.depthMm) {
          const [tooDeep] = await tx.execute(sql`select count(*)::int as n from devices d join racks r on r.id = d.rack_id where d.model_id = ${id} and d.position_u is not null and r.depth_mm < ${input.depthMm}`).then((r) => r.rows as { n: number }[]);
          if ((tooDeep?.n ?? 0) > 0) throw new BadRequestException({ error: 'model_too_deep', message: `${tooDeep!.n} racked device(s) of this model would no longer fit their rack` });
        }
        const [m] = await tx.update(deviceModels).set(this.cols(input)).where(eq(deviceModels.id, id)).returning();
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'device_model.update', target: { type: 'device_model', id }, outcome: 'success', meta, metadata: { name: m!.name } }, tx);
        return m!;
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async deleteModel(p: Principal, id: string, meta: RequestMeta) {
    const m = await this.getModel(p, id);
    try {
      await this.db.transaction(async (tx) => {
        await tx.delete(deviceModels).where(eq(deviceModels.id, id));
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'device_model.delete', target: { type: 'device_model', id }, outcome: 'success', meta, metadata: { name: m.name } }, tx);
      });
    } catch (err) {
      rethrowDbError(err, { fk: 'Devices still use this model' });
    }
  }

  private cols(i: ModelInput) {
    return {
      manufacturerId: i.manufacturerId,
      name: i.name,
      category: i.category,
      uHeight: i.uHeight,
      depthMm: i.depthMm ?? null,
      fullDepth: i.fullDepth,
      typicalPowerW: i.typicalPowerW ?? null,
      idlePowerW: i.idlePowerW ?? null,
      maxPowerW: i.maxPowerW ?? null,
      psuCount: i.psuCount ?? null,
      psuRatedW: i.psuRatedW ?? null,
      weightKg: i.weightKg == null ? null : String(i.weightKg),
      notes: i.notes ?? null,
    };
  }

  private async checkManufacturer(p: Principal, id: string) {
    const [m] = await this.db.select({ id: manufacturers.id }).from(manufacturers).where(and(eq(manufacturers.id, id), eq(manufacturers.orgId, p.orgId)));
    if (!m) throw new BadRequestException({ error: 'invalid_manufacturer', message: 'Manufacturer does not exist' });
  }
}
