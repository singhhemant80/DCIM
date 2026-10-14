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
