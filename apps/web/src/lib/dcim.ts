import type { DeviceCategory, LifecycleState, RackFace } from '@crapplet/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface RowT {
  id: string;
  roomId: string;
  name: string;
  position: number;
}
export interface RoomT {
  id: string;
  buildingId: string;
  name: string;
  floor: string | null;
  gridCols: number;
  gridRows: number;
  notes: string | null;
  rackCount: number;
  rows: RowT[];
}
export interface BuildingT {
  id: string;
  datacenterId: string;
  name: string;
  notes: string | null;
  rooms: RoomT[];
}
export interface DatacenterT {
  id: string;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  timezone: string | null;
  notes: string | null;
  buildings: BuildingT[];
  counts?: { buildings: number; rooms: number; racks: number; devices: number };
}

export interface RackT {
  id: string;
  roomId: string;
  rowId: string | null;
  name: string;
  uHeight: number;
  depthMm: number;
  maxPowerW: number | null;
  maxWeightKg: number | null;
  numbering: 'bottom_up' | 'top_down';
  status: 'planned' | 'active' | 'reserved' | 'decommissioned';
  customerId: string | null;
  customerName: string | null;
  gridX: number | null;
  gridY: number | null;
  assetTag: string | null;
  serial: string | null;
  notes: string | null;
  location: { datacenterId: string; datacenterCode: string; buildingName: string; roomName: string; rowName: string | null };
  usedU: number;
  reservedU: number;
  freeU: number;
  deviceCount: number;
}

export interface ElevationDevice {
  id: string;
  assetTag: string;
  hostname: string | null;
  category: DeviceCategory;
  lifecycleState: LifecycleState;
  positionU: number | null;
  uHeight: number;
  face: RackFace | null;
  fullDepth: boolean;
  ownership: 'company' | 'customer';
  customerId: string | null;
  customerName: string | null;
  modelName: string;
  manufacturerName: string;
}
export interface ReservationT {
  id: string;
  startU: number;
  endU: number;
  customerId: string | null;
  customerName: string | null;
  reason: string;
  expiresAt: string | null;
  expired: boolean;
}
export interface ElevationT {
  rack: RackT;
  devices: ElevationDevice[];
  zeroU: ElevationDevice[];
  reservations: ReservationT[];
}

export interface ModelT {
  id: string;
  manufacturerId: string;
  manufacturerName: string;
  name: string;
  category: DeviceCategory;
  uHeight: number;
  depthMm: number | null;
  fullDepth: boolean;
  typicalPowerW: number | null;
  idlePowerW: number | null;
  maxPowerW: number | null;
  psuCount: number | null;
  psuRatedW: number | null;
  weightKg: number | null;
  notes: string | null;
  deviceCount: number;
}
export interface ManufacturerT {
  id: string;
  name: string;
  modelCount: number;
}

export interface DeviceT {
  id: string;
  assetTag: string;
  hostname: string | null;
  serial: string | null;
  category: DeviceCategory;
  lifecycleState: LifecycleState;
  ownership: 'company' | 'customer';
  customerId: string | null;
  customerName: string | null;
  customerCode?: string | null;
  model: { id: string; name: string; manufacturer: string; uHeight: number; fullDepth: boolean };
  location: { rackId: string; rackName: string; roomName: string; datacenterId: string; datacenterCode: string; positionU: number | null; face: RackFace | null } | null;
  cpu: string | null;
  cpuCount: number | null;
  ramGb: number | null;
  dimmLayout: string | null;
  disks: { slot?: string | null; type: string; sizeGb: number; model?: string | null }[];
  raid: string | null;
  nics: { name: string; mac?: string | null; speed?: string | null }[];
  os: string | null;
  warrantyExpires: string | null;
  mgmtType?: string | null;
  mgmtAddress?: string | null;
  biosVersion?: string | null;
  bmcFirmware?: string | null;
  purchaseDate?: string | null;
  supplier?: string | null;
  purchaseCost?: number | null;
  currency?: string | null;
  eolDate?: string | null;
  notes?: string | null;
  custom?: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
}

export interface EventT {
  id: number;
  occurredAt: string;
  actorLabel: string | null;
  kind: string;
  summary: string;
}

export interface SparePartT {
  id: string;
  datacenterId: string | null;
  datacenterCode: string | null;
  kind: string;
  manufacturer: string | null;
  partNumber: string;
  description: string;
  quantity: number;
  minQuantity: number;
  location: string | null;
  unitCost: number | null;
  notes: string | null;
  lowStock: boolean;
}

export const useTree = () => useQuery({ queryKey: ['dcim', 'tree'], queryFn: () => api.get<DatacenterT[]>('/dcim/tree') });
export const useModels = () => useQuery({ queryKey: ['dcim', 'models'], queryFn: () => api.get<ModelT[]>('/dcim/models') });
export const useManufacturers = () => useQuery({ queryKey: ['dcim', 'manufacturers'], queryFn: () => api.get<ManufacturerT[]>('/dcim/manufacturers') });
export const useRacks = (params = '') => useQuery({ queryKey: ['dcim', 'racks', params], queryFn: () => api.get<RackT[]>(`/dcim/racks${params}`) });

/** Flattens the tree into labelled room options: "MUM1 / Tower A / Hall 1". */
export function roomOptions(tree: DatacenterT[] | undefined) {
  return (tree ?? []).flatMap((dc) => dc.buildings.flatMap((b) => b.rooms.map((r) => ({ id: r.id, label: `${dc.code} / ${b.name} / ${r.name}`, room: r, datacenter: dc }))));
}

export const STATE_TONE: Record<LifecycleState, 'ok' | 'warn' | 'crit' | 'est' | 'neutral' | 'accent'> = {
  planned: 'neutral',
  received: 'neutral',
  inventory: 'neutral',
  reserved: 'est',
  racked: 'accent',
  provisioning: 'est',
  active: 'ok',
  maintenance: 'warn',
  retired: 'neutral',
};

/** Days until a date (negative when past). */
export function daysUntil(date: string | null | undefined): number | null {
  if (!date) return null;
  const ms = new Date(`${date}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime();
  return Math.round(ms / 86_400_000);
}
