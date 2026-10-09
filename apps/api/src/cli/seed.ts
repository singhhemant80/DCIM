import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { buildings, customers, datacenters, deviceEvents, deviceModels, devices, manufacturers, rackRows, racks, rooms, organizations, roles, spareParts, userRoles, users } from '../db/schema';
import { PasswordService } from '../auth/password.service';
import { fail, withDb } from './common';

/**
 * Development sample data: two customers and two example users (a NOC
 * engineer and a customer administrator). Refuses to run in production.
 * Idempotent — existing records are left untouched.
 */
withDb(async (db) => {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed sample data in production');
  const [org] = await db.select().from(organizations).limit(1);
  if (!org) throw new Error('No organization yet — run create-admin first');

  const sample = [
    { code: 'ACME', name: 'Acme Hosting Pvt Ltd', contactEmail: 'noc@acme.example' },
    { code: 'GLOBEX', name: 'Globex Trading LLP', contactEmail: 'it@globex.example' },
  ];
  for (const c of sample) {
    await db.insert(customers).values({ ...c, orgId: org.id, notes: 'Sample data (seed)' }).onConflictDoNothing();
  }
  const [acme] = await db.select().from(customers).where(and(eq(customers.orgId, org.id), eq(customers.code, 'ACME')));

  const passwords = new PasswordService();
  const password = process.env.CDCIM_SEED_PASSWORD ?? randomBytes(15).toString('base64url');
  const hash = await passwords.hash(password);
  const people = [
    { email: 'noc@crapplet.example', name: 'Sample NOC Engineer', userType: 'staff' as const, customerId: null, role: 'noc_engineer' },
    { email: 'admin@acme.example', name: 'Acme Portal Admin', userType: 'customer' as const, customerId: acme!.id, role: 'customer_admin' },
  ];
  const created: string[] = [];
  for (const person of people) {
    const [exists] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${person.email}`);
    if (exists) continue;
    const [role] = await db.select().from(roles).where(and(eq(roles.orgId, org.id), eq(roles.systemKey, person.role)));
    const [u] = await db
      .insert(users)
      .values({ orgId: org.id, email: person.email, name: person.name, passwordHash: hash, userType: person.userType, customerId: person.customerId })
      .returning();
    await db.insert(userRoles).values({ userId: u!.id, roleId: role!.id });
    created.push(person.email);
  }
  process.stdout.write(`Seeded ${sample.length} sample customers.\n`);

  // ---- Phase 2 sample physical inventory (development only) -----------------
  const [existingDc] = await db.select().from(datacenters).where(and(eq(datacenters.orgId, org.id), eq(datacenters.code, 'MUM1')));
  if (existingDc) {
    process.stdout.write('Sample datacenter MUM1 already present; skipping physical sample data.\n');
    return;
  }
  const [globex] = await db.select().from(customers).where(and(eq(customers.orgId, org.id), eq(customers.code, 'GLOBEX')));
  const [dc] = await db.insert(datacenters).values({ orgId: org.id, code: 'MUM1', name: 'Mumbai 1 (sample)', city: 'Mumbai', country: 'IN', timezone: 'Asia/Kolkata', notes: 'Sample data (seed)' }).returning();
  const [bld] = await db.insert(buildings).values({ orgId: org.id, datacenterId: dc!.id, name: 'Tower A' }).returning();
  const [hall] = await db.insert(rooms).values({ orgId: org.id, buildingId: bld!.id, name: 'Hall 1', floor: '2', gridCols: 14, gridRows: 8 }).returning();
  const [rowA] = await db.insert(rackRows).values({ orgId: org.id, roomId: hall!.id, name: 'A', position: 0 }).returning();
  const [rowB] = await db.insert(rackRows).values({ orgId: org.id, roomId: hall!.id, name: 'B', position: 1 }).returning();
  const rackDefs = [
    { name: 'A01', rowId: rowA!.id, gridX: 2, gridY: 2 },
    { name: 'A02', rowId: rowA!.id, gridX: 3, gridY: 2 },
    { name: 'A03', rowId: rowA!.id, gridX: 4, gridY: 2 },
    { name: 'B01', rowId: rowB!.id, gridX: 2, gridY: 5, customerId: globex!.id },
    { name: 'B02', rowId: rowB!.id, gridX: 3, gridY: 5 },
  ];
  const rk: Record<string, string> = {};
  for (const r of rackDefs) {
    const [row] = await db.insert(racks).values({ orgId: org.id, roomId: hall!.id, uHeight: 42, depthMm: 1070, maxPowerW: 6000, ...r }).returning();
    rk[r.name] = row!.id;
  }
  const mf: Record<string, string> = {};
  for (const name of ['Dell', 'MikroTik', 'Cisco', 'Fortinet', 'APC']) {
    const [m] = await db.insert(manufacturers).values({ orgId: org.id, name }).returning();
    mf[name] = m!.id;
  }
  const modelDefs = [
    { key: 'r630', manufacturerId: mf.Dell!, name: 'PowerEdge R630', category: 'server' as const, uHeight: 1, depthMm: 684, fullDepth: true, typicalPowerW: 250, idlePowerW: 110, maxPowerW: 495, psuCount: 2, psuRatedW: 750 },
    { key: 'r640', manufacturerId: mf.Dell!, name: 'PowerEdge R640', category: 'server' as const, uHeight: 1, depthMm: 734, fullDepth: true, typicalPowerW: 290, idlePowerW: 120, maxPowerW: 650, psuCount: 2, psuRatedW: 750 },
    { key: 'ccr2004', manufacturerId: mf.MikroTik!, name: 'CCR2004-1G-12S+2XS', category: 'router' as const, uHeight: 1, depthMm: 230, fullDepth: false, typicalPowerW: 30, maxPowerW: 55, psuCount: 2, psuRatedW: 100 },
    { key: 'ccr2116', manufacturerId: mf.MikroTik!, name: 'CCR2116-12G-4S+', category: 'router' as const, uHeight: 1, depthMm: 290, fullDepth: false, typicalPowerW: 45, maxPowerW: 90, psuCount: 2, psuRatedW: 150 },
    { key: 'n9k', manufacturerId: mf.Cisco!, name: 'Nexus 9372TX', category: 'switch' as const, uHeight: 1, depthMm: 457, fullDepth: true, typicalPowerW: 210, maxPowerW: 530, psuCount: 2, psuRatedW: 650 },
    { key: 'fg40f', manufacturerId: mf.Fortinet!, name: 'FortiGate 40F', category: 'firewall' as const, uHeight: 1, depthMm: 160, fullDepth: false, typicalPowerW: 12, maxPowerW: 15 },
    { key: 'pdu', manufacturerId: mf.APC!, name: 'AP8653 Metered PDU', category: 'pdu' as const, uHeight: 0, fullDepth: false },
  ];
  const md: Record<string, typeof deviceModels.$inferSelect> = {};
  for (const { key, ...m } of modelDefs) {
    const [row] = await db.insert(deviceModels).values({ orgId: org.id, ...m }).returning();
    md[key] = row!;
  }
  const plus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  type DevDef = { tag: string; host: string; model: string; rack?: string; u?: number; face?: 'front' | 'rear'; state: typeof devices.$inferInsert['lifecycleState']; customerId?: string; ownership?: 'company' | 'customer'; warranty?: string; ram?: number; cpu?: string };
  const defs: DevDef[] = [
    { tag: 'CR-NET-001', host: 'edge-rtr-01', model: 'ccr2116', rack: 'A01', u: 42, face: 'front', state: 'active' },
    { tag: 'CR-NET-002', host: 'edge-rtr-02', model: 'ccr2004', rack: 'A01', u: 42, face: 'rear', state: 'active' },
    { tag: 'CR-NET-003', host: 'core-sw-01', model: 'n9k', rack: 'A01', u: 40, state: 'active' },
    { tag: 'CR-NET-004', host: 'fw-mgmt-01', model: 'fg40f', rack: 'A01', u: 38, state: 'active' },
    { tag: 'CR-PDU-001', host: 'pdu-a01-l', model: 'pdu', rack: 'A01', state: 'active' },
    ...Array.from({ length: 10 }, (_, i): DevDef => ({ tag: `CR-SRV-${String(i + 1).padStart(3, '0')}`, host: `pve-${String(i + 1).padStart(2, '0')}`, model: i % 2 ? 'r640' : 'r630', rack: 'A02', u: 2 + i * 2, state: i === 7 ? 'maintenance' : 'active', ram: i % 2 ? 384 : 256, cpu: i % 2 ? 'Intel Xeon Gold 6230' : 'Intel Xeon E5-2690 v4', warranty: plus(i === 1 ? -20 : i === 3 ? 45 : 400) })),
    ...Array.from({ length: 6 }, (_, i): DevDef => ({ tag: `CR-SRV-1${String(i + 1).padStart(2, '0')}`, host: `ded-${String(i + 1).padStart(2, '0')}`, model: 'r640', rack: 'A03', u: 10 + i, state: i < 4 ? 'active' : 'racked', customerId: i < 3 ? acme!.id : undefined, ram: 128, cpu: 'Intel Xeon Silver 4214', warranty: plus(i === 0 ? 70 : 600) })),
    { tag: 'GLX-001', host: 'globex-app-01', model: 'r640', rack: 'B01', u: 20, state: 'active', customerId: globex!.id, ownership: 'customer' },
    { tag: 'GLX-002', host: 'globex-db-01', model: 'r640', rack: 'B01', u: 22, state: 'active', customerId: globex!.id, ownership: 'customer' },
    { tag: 'CR-SRV-201', host: 'spare-01', model: 'r630', state: 'inventory', ram: 64 },
    { tag: 'CR-SRV-202', host: 'spare-02', model: 'r640', state: 'inventory', ram: 128 },
    { tag: 'CR-SRV-203', host: 'incoming-01', model: 'r640', state: 'planned' },
  ];
  for (const d of defs) {
    const m = md[d.model]!;
    const [row] = await db
      .insert(devices)
      .values({
        orgId: org.id,
        modelId: m.id,
        category: m.category,
        uHeight: m.uHeight,
        fullDepth: m.fullDepth,
        assetTag: d.tag,
        hostname: d.host,
        serial: `SN${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
        lifecycleState: d.state,
        rackId: d.rack ? rk[d.rack] : null,
        positionU: d.u ?? null,
        face: d.u ? (d.face ?? 'front') : null,
        customerId: d.customerId ?? null,
        ownership: d.ownership ?? 'company',
        ramGb: d.ram ?? null,
        cpu: d.cpu ?? null,
        cpuCount: d.cpu ? 2 : null,
        warrantyExpires: d.warranty ?? null,
        notes: 'Sample data (seed)',
      })
      .returning();
    await db.insert(deviceEvents).values({ orgId: org.id, deviceId: row!.id, kind: 'created', summary: 'Added by sample data seed', actorLabel: 'seed' });
  }
  await db.insert(spareParts).values([
    { orgId: org.id, datacenterId: dc!.id, kind: 'ram', manufacturer: 'Samsung', partNumber: 'M393A4K40CB2', description: '32GB DDR4-2666 RDIMM', quantity: 14, minQuantity: 8, location: 'Store cage, bin 3' },
    { orgId: org.id, datacenterId: dc!.id, kind: 'ssd', manufacturer: 'Samsung', partNumber: 'MZ7LH960HAJR', description: 'PM883 960GB SATA SSD', quantity: 3, minQuantity: 4, location: 'Store cage, bin 5' },
    { orgId: org.id, datacenterId: dc!.id, kind: 'psu', manufacturer: 'Dell', partNumber: '0RYMG6', description: '750W PSU for R630/R640', quantity: 4, minQuantity: 2 },
    { orgId: org.id, datacenterId: dc!.id, kind: 'transceiver', manufacturer: 'MikroTik', partNumber: 'S+85DLC03D', description: 'SFP+ 10G SR multimode', quantity: 12, minQuantity: 6 },
  ]);
  process.stdout.write('Seeded sample datacenter MUM1 with 5 racks, 7 models, 28 devices and 4 spare parts.\n');
  if (created.length) process.stdout.write(`Sample users ${created.join(', ')} — password: ${password}\n`);
}).catch(fail);
