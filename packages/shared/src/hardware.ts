import { z } from 'zod';

/** Component health as the BMC reports it (Redfish Status.Health); null when not reported. */
export type HwHealth = 'OK' | 'Warning' | 'Critical' | null;

export interface HwProcessor {
  socket: string;
  model: string | null;
  cores: number | null;
  threads: number | null;
  maxSpeedMhz: number | null;
  health: HwHealth;
}
export interface HwMemory {
  slot: string;
  sizeGb: number | null;
  type: string | null;
  speedMhz: number | null;
  manufacturer: string | null;
  partNumber: string | null;
  serial: string | null;
  health: HwHealth;
}
export interface HwController {
  name: string;
  model: string | null;
  firmware: string | null;
  health: HwHealth;
}
export interface HwDrive {
  name: string;
  slot: string | null;
  model: string | null;
  serial: string | null;
  /** SSD or HDD as reported (MediaType). */
  mediaType: string | null;
  /** SATA, SAS, NVMe… */
  protocol: string | null;
  capacityGb: number | null;
  /** Remaining rated endurance (SSDs), if reported. */
  lifeLeftPercent: number | null;
  failurePredicted: boolean | null;
  health: HwHealth;
}
export interface HwVolume {
  name: string;
  raid: string | null;
  capacityGb: number | null;
  health: HwHealth;
}
export interface HwPsu {
  name: string;
  model: string | null;
  serial: string | null;
  capacityW: number | null;
  inputW: number | null;
  outputW: number | null;
  firmware: string | null;
  health: HwHealth;
}
export interface HwFan {
  name: string;
  reading: number | null;
  units: string | null;
  health: HwHealth;
}
export interface HwTemperature {
  name: string;
  celsius: number | null;
  upperCritical: number | null;
  health: HwHealth;
}
export interface HwNic {
  name: string;
  mac: string | null;
  speedMbps: number | null;
  linkStatus: string | null;
  health: HwHealth;
}
export interface HwLogEntry {
  /** Which log it came from (e.g. Sel, IML, FaultList). */
  log: string;
  id: string;
  created: string | null;
  severity: string | null;
  message: string;
  messageId: string | null;
}

/** What a read-only Redfish walk of a server's BMC found. */
export interface HardwareInventory {
  system: {
    manufacturer: string | null;
    model: string | null;
    serial: string | null;
    /** Dell service tag / vendor SKU. */
    sku: string | null;
    biosVersion: string | null;
    powerState: string | null;
    hostName: string | null;
    health: HwHealth;
    cpuCount: number | null;
    cpuModel: string | null;
    logicalCpus: number | null;
    memoryGb: number | null;
  };
  bmc: { model: string | null; firmware: string | null } | null;
  processors: HwProcessor[];
  memory: HwMemory[];
  controllers: HwController[];
  drives: HwDrive[];
  volumes: HwVolume[];
  psus: HwPsu[];
  fans: HwFan[];
  temperatures: HwTemperature[];
  nics: HwNic[];
  logs: HwLogEntry[];
  /** Parts of the walk that failed (the rest is still shown). */
  /** Where the memory list came from when not Redfish (e.g. "WS-Man"); null = Redfish. */
  memorySource?: string | null;
  /** Where the whole inventory came from when not Redfish (e.g. "WS-Man" for older iDRAC firmware); absent = Redfish. */
  source?: string | null;
  warnings: string[];
}

/** Fields of the device record that can be filled from the inventory. */
export const HARDWARE_APPLY_FIELDS = ['serial', 'cpu', 'ram', 'disks', 'nics', 'firmware'] as const;
export const hardwareApplySchema = z.object({ fields: z.array(z.enum(HARDWARE_APPLY_FIELDS)).min(1) });

/* ------------------------------------------------------------------ accessories */

export const ACCESSORY_KINDS = ['dac_cable', 'fiber_cable', 'lan_cable', 'power_cable', 'transceiver', 'rail_kit', 'cable_tray', 'cable_arm', 'bezel', 'other'] as const;
export type AccessoryKind = (typeof ACCESSORY_KINDS)[number];
export const ACCESSORY_LABELS: Record<AccessoryKind, string> = {
  dac_cable: 'DAC cable',
  fiber_cable: 'Fiber cable',
  lan_cable: 'LAN cable',
  power_cable: 'Power cable',
  transceiver: 'Transceiver / SFP',
  rail_kit: 'Rail kit',
  cable_tray: 'Cable tray',
  cable_arm: 'Cable management arm',
  bezel: 'Bezel',
  other: 'Other',
};

const opt = (n: number) => z.string().trim().max(n).nullable().optional();
export const accessorySchema = z.object({
  kind: z.enum(ACCESSORY_KINDS),
  quantity: z.number().int().min(1).max(10_000),
  /** e.g. "SFP28 25G passive", "OM4 LC-LC", "Cat6". */
  description: opt(200),
  lengthM: z.number().min(0).max(10_000).nullable().optional(),
  partNumber: opt(80),
  serial: opt(120),
  notes: opt(1000),
  /** Take this many from a spare-parts stock line (stock goes down, with a movement). */
  sparePartId: z.string().uuid().nullable().optional(),
});
export type AccessoryInput = z.infer<typeof accessorySchema>;

/** A device front photo, as a data URL (the browser shrinks it before upload). */
export const devicePhotoSchema = z.object({
  image: z
    .string()
    .max(1_450_000, 'The photo is too large (at most 1 MB)')
    .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'Upload a JPEG, PNG or WebP image'),
});
export type DevicePhotoInput = z.infer<typeof devicePhotoSchema>;

/* ------------------------------------------------------------------ server health (frequent) */

export const SERVER_ROLLUP_KEYS = ['system', 'cpu', 'memory', 'storage', 'psu', 'fans', 'temperature', 'voltage', 'network', 'battery'] as const;
export type ServerRollupKey = (typeof SERVER_ROLLUP_KEYS)[number];
export const SERVER_ROLLUP_LABELS: Record<ServerRollupKey, string> = {
  system: 'System',
  cpu: 'CPU',
  memory: 'Memory',
  storage: 'Storage',
  psu: 'PSU',
  fans: 'Fans',
  temperature: 'Temp',
  voltage: 'Voltage',
  network: 'Network',
  battery: 'Battery',
};

/** A server's current health from its BMC (read every few minutes; the full hardware walk is daily). Null = not reported. */
export interface ServerHealth {
  /** How it was read: "Redfish", "Redfish + WS-Man", "WS-Man". */
  source: string;
  powerState: string | null;
  /** Health per component as the BMC rolls it up. */
  rollup: Partial<Record<ServerRollupKey, HwHealth>>;
  /** Dell CUPS (iDRAC Enterprise / Datacenter): CPU, memory, IO and overall system usage in %. */
  cpuUsagePct: number | null;
  memoryUsagePct: number | null;
  ioUsagePct: number | null;
  systemUsagePct: number | null;
  inletC: number | null;
  exhaustC: number | null;
  cpuTempC: number | null;
  maxTempC: number | null;
  /** Parts that could not be read (the rest is still used). */
  warnings: string[];
}

/* ------------------------------------------------------------------ BMC set-up in one place */

export const BMC_TYPES = ['idrac', 'ilo', 'irmc', 'redfish', 'ipmi'] as const;
export type BmcType = (typeof BMC_TYPES)[number];
export const BMC_TYPE_LABELS: Record<BmcType, string> = { idrac: 'Dell iDRAC', ilo: 'HPE iLO', irmc: 'Fujitsu iRMC', redfish: 'Other (Redfish)', ipmi: 'IPMI only' };

/**
 * A server's BMC entered once (address, login) and used everywhere it is
 * needed: read-only monitoring (hardware, health, power readings, ping),
 * and — only when ticked — power control and the consoles. Each use is still
 * stored as its own encrypted credential, checked against its own permission.
 */
export const bmcSetupSchema = z
  .object({
    type: z.enum(BMC_TYPES),
    host: z.string().trim().min(1).max(255),
    /** Redfish (HTTPS) port; empty = 443. IPMI: 623. */
    port: z.number().int().min(1).max(65535).nullable().optional(),
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(256),
    verifyTls: z.boolean().default(false),
    /** Power readings from the BMC (on by default). */
    power: z.boolean().default(true),
    /** Use the same login for power on / off / restart and installs. */
    control: z.boolean().default(false),
    /** Serial console over IPMI (IPMI over LAN must be enabled on the BMC). */
    serialConsole: z.boolean().default(false),
    /** The BMC's VNC server password (iDRAC: a separate password), for the graphical console. */
    vncPassword: z.string().min(1).max(64).nullable().optional(),
    /** A separate read-only account for monitoring (recommended); empty = the login above. */
    readOnly: z
      .object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) })
      .nullable()
      .optional(),
  })
  .superRefine((v, ctx) => {
    const ipmiUsed = v.type === 'ipmi' || v.serialConsole;
    if (ipmiUsed && v.username.length > 16) ctx.addIssue({ code: 'custom', path: ['username'], message: 'IPMI user names are at most 16 characters' });
    if (ipmiUsed && v.password.length > 20) ctx.addIssue({ code: 'custom', path: ['password'], message: 'IPMI passwords are at most 20 characters' });
  });
export type BmcSetupInput = z.infer<typeof bmcSetupSchema>;
