import { useQuery } from '@tanstack/react-query';
import { api, type Paginated } from './api';
import { useAuth } from './auth';

export interface AllocationT {
  id: string;
  customerId: string;
  customerName: string;
  serviceId: string | null;
  serviceName: string | null;
  rackId: string;
  rackName: string;
  rackHeight: number;
  roomName: string;
  datacenterId: string;
  datacenterCode: string;
  datacenterName: string;
  kind: 'full' | 'half' | 'quarter' | 'custom';
  part: number | null;
  startU: number;
  endU: number;
  units: number;
  contractedPowerW: number;
  feeds: 'single' | 'a_b';
  breakerAmps: number | null;
  voltage: number | null;
  startDate: string;
  endDate: string | null;
  endedAt: string | null;
  endReason: string | null;
  active: boolean;
  notes: string | null;
  power: { measuredW: number; estimatedW: number; unknownDevices: number; devices: number; measuredPct: number | null; totalPct: number | null; overContract: boolean; mayExceed: boolean } | null;
}

export interface CrossConnectT {
  id: string;
  customerId: string;
  customerName: string;
  serviceId: string | null;
  serviceName: string | null;
  aDeviceId: string | null;
  aDeviceName: string | null;
  aInterfaceName: string | null;
  aLabel: string;
  zLabel: string;
  loaReference: string | null;
  media: string;
  speed: string | null;
  status: 'requested' | 'approved' | 'rejected' | 'in_progress' | 'active' | 'decommissioned';
  circuitId: string | null;
  cableId: string | null;
  cableLabel: string | null;
  statusReason: string | null;
  notes: string | null;
  requestedBy: string | null;
  requestedAt: string;
  completedAt: string | null;
}

export interface ShipmentT {
  id: string;
  customerId: string;
  customerName: string;
  datacenterCode: string;
  direction: 'inbound' | 'outbound';
  carrier: string;
  trackingNumber: string | null;
  expectedOn: string | null;
  packages: number;
  description: string;
  instructions: string | null;
  status: 'expected' | 'received' | 'delivered' | 'shipped_out' | 'cancelled';
  packagesReceived: number | null;
  storageLocation: string | null;
  conditionNote: string | null;
  receivedAt: string | null;
  receivedBy: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface VisitT {
  id: string;
  customerId: string;
  customerName: string;
  datacenterCode: string;
  visitors: { name: string; company?: string | null; idLast4?: string | null }[];
  startsAt: string;
  endsAt: string;
  purpose: string;
  status: 'requested' | 'approved' | 'denied' | 'checked_in' | 'checked_out' | 'cancelled';
  escort: boolean;
  badge: string | null;
  decisionNote: string | null;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  requestedBy: string | null;
}

export interface OverviewT {
  allocations: number;
  units: number;
  contractedPowerW: number;
  measuredW: number;
  estimatedW: number;
  unknownDevices: number;
  overContract: { id: string; customerName: string; rackName: string; datacenterCode: string }[];
  mayExceed: { id: string; customerName: string; rackName: string; datacenterCode: string }[];
  bandwidth: { inBps: number | null; outBps: number | null; ports: number; freshPorts: number } | null;
  open: { crossConnects: number; shipments: number; visits: number; tickets: number };
  activeCrossConnects: number;
  activeServices: number;
}

export interface ServiceT {
  id: string;
  customerId: string;
  customerName: string;
  kind: string;
  name: string;
  description: string | null;
  status: 'pending' | 'active' | 'suspended' | 'cancelled' | 'terminated';
  startDate: string | null;
  endDate: string | null;
  billingReference: string | null;
  deviceId: string | null;
  deviceName: string | null;
  guestId: string | null;
  guestName: string | null;
  notes: string | null;
  createdAt: string;
}

export interface TicketT {
  id: string;
  number: number;
  customerId: string | null;
  customerName: string | null;
  kind: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed';
  subject: string;
  deviceId: string | null;
  deviceName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  authorizedMinutes: number | null;
  minutesSpent: number;
  createdBy: string;
  lastPublicReplyBy: 'staff' | 'customer' | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketDetailT extends TicketT {
  messages: { id: number; at: string; authorLabel: string | null; authorType: 'staff' | 'customer' | 'system'; internal: boolean; body: string }[];
  time: { id: number; at: string; userLabel: string; minutes: number; note: string; billable: boolean }[];
}

export const watts = (w: number | null | undefined) => (w === null || w === undefined ? '—' : w >= 1000 ? `${(w / 1000).toFixed(w >= 10_000 ? 1 : 2)} kW` : `${Math.round(w)} W`);

export function useCustomerOptions() {
  const { me } = useAuth();
  return useQuery({
    queryKey: ['customers', 'options'],
    queryFn: () => api.get<Paginated<{ id: string; name: string; code: string; status: string }>>('/customers?pageSize=200'),
    enabled: me?.user.userType === 'staff',
  });
}

export function useSites() {
  return useQuery({ queryKey: ['colo', 'sites'], queryFn: () => api.get<{ id: string; code: string; name: string }[]>('/colocation/sites') });
}

/** A customer's own devices (customers) or every device of the chosen customer (staff). */
export function useCustomerDevices(customerId: string | null | undefined) {
  const { me } = useAuth();
  const staff = me?.user.userType === 'staff';
  return useQuery({
    queryKey: ['dcim', 'devices', 'of', staff ? customerId : 'mine'],
    queryFn: () => api.get<Paginated<{ id: string; assetTag: string; hostname: string | null }>>(`/dcim/devices?pageSize=200${staff && customerId ? `&customerId=${customerId}` : ''}`),
    enabled: !staff || !!customerId,
  });
}
