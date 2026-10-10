import { JOB_KIND_LABELS, JOB_STATUS_LABELS, type JobKind, type JobStatus, type PowerAction } from '@crapplet/shared';

export interface JobT {
  id: string;
  kind: JobKind;
  status: JobStatus;
  deviceId: string | null;
  deviceName: string | null;
  guestId: string | null;
  guestName: string | null;
  imageId: string | null;
  imageName: string | null;
  params: Record<string, unknown>;
  currentStep: number;
  stepCount: number | null;
  error: string | null;
  cancelRequested: boolean;
  /** Completed jobs: false when the outcome could not be observed. */
  verified: boolean | null;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobStepT {
  seq: number;
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  detail: string | null;
  error: string | null;
}

export interface JobDetailT extends JobT {
  result: Record<string, unknown> | null;
  deadlineAt: string | null;
  steps: JobStepT[];
  events: { id: number; at: string; level: 'info' | 'warn' | 'error'; message: string }[];
}

export interface OsImageT {
  id: string;
  name: string;
  family: string;
  version: string | null;
  arch: string;
  isoUrl: string | null;
  isoSha256: string | null;
  kernelUrl: string | null;
  kernelSha256: string | null;
  initrdUrl: string | null;
  initrdSha256: string | null;
  bootArgs: string | null;
  templateKind: 'kickstart' | 'preseed' | 'autoinstall' | 'none';
  template: string | null;
  enabled: boolean;
  notes: string | null;
  verifyStatus: 'unverified' | 'verifying' | 'verified' | 'mismatch' | 'error';
  verifiedAt: string | null;
  verifyError: string | null;
  sizes: Record<string, number>;
}

export interface ControlStatusT {
  deviceId: string;
  name: string;
  configured: boolean;
  actions: PowerAction[];
  credential: { kind: 'redfish' | 'ipmi'; host: string; port: number | null; username: string; rotatedAt: string } | null;
  activeJob: { id: string; kind: JobKind; status: JobStatus } | null;
}

export interface IntegrationT {
  id: string;
  kind: 'proxmox' | 'virtualizor';
  name: string;
  url: string;
  verifyTls: boolean;
  params: { tokenId?: string; actionTokenId?: string | null };
  actionsEnabled: boolean;
  enabled: boolean;
  syncMinutes: number;
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
  hosts: number;
  guests: number;
}

export interface VirtHostT {
  id: string;
  integrationId: string;
  integrationName: string;
  integrationKind: string;
  externalId: string;
  name: string;
  status: string | null;
  cpuPct: number | null;
  cpus: number | null;
  memUsed: number | null;
  memTotal: number | null;
  uptimeSeconds: number | null;
  deviceId: string | null;
  deviceName: string | null;
  guests: number;
  lastSeenAt: string | null;
  missingSince: string | null;
}

export interface VirtGuestT {
  id: string;
  integrationId: string | null;
  integrationName: string | null;
  integrationKind: 'proxmox' | 'virtualizor';
  externalId: string;
  virtType: string | null;
  name: string;
  status: string | null;
  cpus: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  uptimeSeconds: number | null;
  ipAddresses: string[];
  hostName: string | null;
  customerId: string | null;
  customerName: string | null;
  actionsEnabled: boolean;
  activeJob: string | null;
  lastSeenAt: string | null;
  missingSince: string | null;
}

export type Tone = 'ok' | 'warn' | 'crit' | 'est' | 'neutral' | 'accent';

export const jobTone = (s: JobStatus): Tone =>
  s === 'completed' ? 'ok' : s === 'failed' ? 'crit' : s === 'recovery' ? 'warn' : s === 'cancelled' ? 'neutral' : 'accent';
export const jobStatusLabel = (s: JobStatus) => JOB_STATUS_LABELS[s] ?? s;
export const jobKindLabel = (k: JobKind) => JOB_KIND_LABELS[k] ?? k;
export const isActive = (s: JobStatus) => ['queued', 'running', 'waiting', 'verifying', 'recovery'].includes(s);

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function duration(s: number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** A random key per submitted form, so a double-click or retry never queues the action twice. */
export const newIdempotencyKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
