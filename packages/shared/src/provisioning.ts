import { z } from 'zod';
import { paginationSchema } from './schemas';

/* ------------------------------------------------------------------ jobs */

export const JOB_KINDS = ['power_action', 'os_install', 'image_verify', 'guest_action'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const JOB_KIND_LABELS: Record<JobKind, string> = { power_action: 'Power action', os_install: 'OS installation', image_verify: 'Image checksum', guest_action: 'VM action' };

/**
 * queued → running → (waiting ⇄ running) → verifying → completed
 * Any active state → failed | cancelled. An interruption inside a step that is
 * not safe to repeat moves the job to `recovery` until an operator decides.
 */
export const JOB_STATUSES = ['queued', 'running', 'waiting', 'verifying', 'completed', 'failed', 'cancelled', 'recovery'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'waiting', 'verifying', 'recovery'];
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting',
  verifying: 'Verifying',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  recovery: 'Needs a decision',
};

export const jobListQuerySchema = paginationSchema.extend({
  status: z.enum(['active', 'finished', 'all']).default('all'),
  kind: z.enum(JOB_KINDS).optional(),
  deviceId: z.string().uuid().optional(),
});

export const recoveryDecisionSchema = z.object({
  /** retry: run the interrupted step again; skip: treat it as done; fail: stop the job (cleanup still runs). */
  decision: z.enum(['retry', 'skip', 'fail']),
  note: z.string().trim().max(500).optional(),
});

/* ------------------------------------------------------------------ power actions */

export const POWER_ACTIONS = ['on', 'off', 'graceful_shutdown', 'restart', 'graceful_restart', 'power_cycle'] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];
export const POWER_ACTION_LABELS: Record<PowerAction, string> = {
  on: 'Power on',
  off: 'Power off (hard)',
  graceful_shutdown: 'Shut down (ACPI)',
  restart: 'Restart (hard reset)',
  graceful_restart: 'Restart (ACPI)',
  power_cycle: 'Power cycle',
};

export const powerActionSchema = z.object({
  action: z.enum(POWER_ACTIONS),
  /** Type the device's hostname (or asset tag) to confirm. */
  confirm: z.string().trim().min(1).max(120),
});

/** Access a BMC with a privilege that can change power and boot settings. Separate from the read-only credential. */
export const controlCredentialSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('redfish'),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(256),
    scheme: z.enum(['https', 'http']).default('https'),
    verifyTls: z.boolean().default(true),
    timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
  }),
  z.object({
    kind: z.literal('ipmi'),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    username: z.string().trim().min(1).max(16),
    password: z.string().min(1).max(20, 'IPMI passwords are at most 20 characters'),
    /** Power control needs OPERATOR. */
    ipmiPrivilege: z.enum(['OPERATOR', 'ADMINISTRATOR']).default('OPERATOR'),
    timeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
  }),
]);
export type ControlCredentialInput = z.infer<typeof controlCredentialSchema>;

/* ------------------------------------------------------------------ images */

export const OS_FAMILIES = ['rhel', 'debian', 'ubuntu', 'proxmox', 'esxi', 'windows', 'other'] as const;
export const TEMPLATE_KINDS = ['kickstart', 'preseed', 'autoinstall', 'none'] as const;
export const TEMPLATE_KIND_LABELS: Record<(typeof TEMPLATE_KINDS)[number], string> = {
  kickstart: 'Kickstart (RHEL, Alma, Rocky)',
  preseed: 'Preseed (Debian)',
  autoinstall: 'Autoinstall / cloud-init (Ubuntu)',
  none: 'None (the image is fully unattended on its own)',
};
export const IMAGE_VERIFY_STATUSES = ['unverified', 'verifying', 'verified', 'mismatch', 'error'] as const;

const fileUrl = z
  .string()
  .trim()
  .url()
  .max(1000)
  .refine((u) => /^https?:\/\//i.test(u) && !/^https?:\/\/[^/]*@/i.test(u), 'An http(s) URL without credentials');
const sha256 = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{64}$/, 'A SHA-256 checksum (64 hex characters)');

export const osImageSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    family: z.enum(OS_FAMILIES),
    version: z.string().trim().max(40).nullable().optional(),
    arch: z.enum(['x86_64', 'aarch64']).default('x86_64'),
    /** Boot ISO for Redfish virtual media. */
    isoUrl: fileUrl.nullable().optional(),
    isoSha256: sha256.nullable().optional(),
    /** Kernel and initrd for PXE / iPXE. */
    kernelUrl: fileUrl.nullable().optional(),
    kernelSha256: sha256.nullable().optional(),
    initrdUrl: fileUrl.nullable().optional(),
    initrdSha256: sha256.nullable().optional(),
    /** Extra kernel arguments for PXE ({{configUrl}} and other variables are substituted). */
    bootArgs: z.string().trim().max(2000).nullable().optional(),
    templateKind: z.enum(TEMPLATE_KINDS).default('none'),
    /** Unattended-install template; variables like {{hostname}} are substituted per job. */
    template: z.string().max(100_000).nullable().optional(),
    enabled: z.boolean().default(true),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.isoUrl && !v.kernelUrl) ctx.addIssue({ code: 'custom', path: ['isoUrl'], message: 'Give an ISO (virtual media) or a kernel and initrd (PXE)' });
    if (v.isoUrl && !v.isoSha256) ctx.addIssue({ code: 'custom', path: ['isoSha256'], message: 'Every file needs its SHA-256' });
    if (v.kernelUrl && (!v.initrdUrl || !v.kernelSha256 || !v.initrdSha256)) ctx.addIssue({ code: 'custom', path: ['initrdUrl'], message: 'PXE needs a kernel and an initrd, each with its SHA-256' });
    if (v.templateKind !== 'none' && !v.template?.trim()) ctx.addIssue({ code: 'custom', path: ['template'], message: 'Enter the template' });
  });
export type OsImageInput = z.infer<typeof osImageSchema>;

/* ------------------------------------------------------------------ installs */

export const INSTALL_METHODS = ['redfish_virtual_media', 'pxe'] as const;
export type InstallMethod = (typeof INSTALL_METHODS)[number];
export const INSTALL_METHOD_LABELS: Record<InstallMethod, string> = { redfish_virtual_media: 'Redfish virtual media (ISO)', pxe: 'PXE / iPXE (network boot)' };

export const installSchema = z
  .object({
    deviceId: z.string().uuid(),
    imageId: z.string().uuid(),
    method: z.enum(INSTALL_METHODS),
    hostname: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, 'A valid host name'),
    /** NIC that network-boots (PXE) and that the address is configured on. */
    macAddress: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/, 'A MAC address like 52:54:00:12:34:56')
      .nullable()
      .optional(),
    network: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('dhcp') }),
      z.object({
        mode: z.literal('static'),
        address: z.string().trim().ip(),
        prefixLength: z.number().int().min(1).max(128),
        gateway: z.string().trim().ip().nullable().optional(),
        nameservers: z.array(z.string().trim().ip()).max(4).default([]),
      }),
    ]),
    /** Write-only; stored encrypted, rendered into templates only as a SHA-512 crypt hash. */
    rootPassword: z.string().min(12, 'At least 12 characters').max(200).nullable().optional(),
    /** The comment is limited to plain characters because keys are written raw into kickstart/preseed/YAML. */
    sshKeys: z.array(z.string().trim().regex(/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( [\w.@+=:-]{1,200})?$/, 'An OpenSSH public key (comment: letters, digits and . @ + = : - _ only)')).max(10).default([]),
    /** How success is verified: the installer reports back (template), or the new system answers on a TCP port. */
    verify: z.discriminatedUnion('by', [z.object({ by: z.literal('callback') }), z.object({ by: z.literal('tcp'), port: z.number().int().min(1).max(65535).default(22) })]).default({ by: 'callback' }),
    /** Minutes to wait for the installer before failing. */
    timeoutMinutes: z.number().int().min(10).max(600).default(120),
    /** Type the device's hostname (or asset tag) to confirm that its disks will be erased. */
    confirm: z.string().trim().min(1).max(120),
    wipeAcknowledged: z.literal(true, { errorMap: () => ({ message: 'Confirm that the server’s disks will be erased' }) }),
  })
  .superRefine((v, ctx) => {
    if (v.method === 'pxe' && !v.macAddress) ctx.addIssue({ code: 'custom', path: ['macAddress'], message: 'PXE needs the MAC address of the boot NIC' });
    if (v.verify.by === 'tcp' && v.network.mode !== 'static') ctx.addIssue({ code: 'custom', path: ['verify'], message: 'A TCP check needs a static address' });
  });
export type InstallInput = z.infer<typeof installSchema>;

/** Callback from the installer (the per-job token is in the URL). */
export const bootCallbackSchema = z.object({
  status: z.enum(['started', 'done', 'failed']),
  message: z.string().trim().max(1000).optional(),
});

/* ------------------------------------------------------------------ virtualization */

export const VIRT_KINDS = ['proxmox', 'virtualizor'] as const;
export type VirtKind = (typeof VIRT_KINDS)[number];

export const virtIntegrationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('proxmox'),
    name: z.string().trim().min(1).max(80),
    url: fileUrl,
    verifyTls: z.boolean().default(true),
    /** Read token, e.g. dcim@pve!sync (role PVEAuditor). */
    tokenId: z.string().trim().regex(/^[^\s!@]+@[^\s!@]+![A-Za-z0-9_-]+$/, 'Like dcim@pve!sync'),
    tokenSecret: z.string().trim().min(8).max(200),
    /** Optional second token allowed to start/stop VMs (a separate, narrower role). Without it, VM actions are off. */
    actionTokenId: z.string().trim().regex(/^[^\s!@]+@[^\s!@]+![A-Za-z0-9_-]+$/, 'Like dcim@pve!actions').nullable().optional(),
    actionTokenSecret: z.string().trim().min(8).max(200).nullable().optional(),
    syncMinutes: z.number().int().min(1).max(1440).default(5),
    enabled: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('virtualizor'),
    name: z.string().trim().min(1).max(80),
    url: fileUrl,
    verifyTls: z.boolean().default(true),
    apiKey: z.string().trim().min(8).max(200),
    apiPass: z.string().trim().min(8).max(200),
    /** Allow VM actions with this key (Virtualizor admin keys can't be scoped). */
    actionsEnabled: z.boolean().default(false),
    syncMinutes: z.number().int().min(1).max(1440).default(5),
    enabled: z.boolean().default(true),
  }),
]);
export type VirtIntegrationInput = z.infer<typeof virtIntegrationSchema>;

export const GUEST_ACTIONS = ['start', 'stop', 'shutdown', 'reboot', 'suspend', 'resume'] as const;
export type GuestAction = (typeof GUEST_ACTIONS)[number];
export const GUEST_ACTION_LABELS: Record<GuestAction, string> = { start: 'Start', stop: 'Stop (hard)', shutdown: 'Shut down', reboot: 'Reboot', suspend: 'Suspend', resume: 'Resume' };

export const guestActionSchema = z.object({ action: z.enum(GUEST_ACTIONS), confirm: z.string().trim().min(1).max(200) });
export const guestAssignSchema = z.object({ customerId: z.string().uuid().nullable() });
export const hostMapSchema = z.object({ deviceId: z.string().uuid().nullable() });
export const guestListQuerySchema = paginationSchema.extend({
  kind: z.enum(VIRT_KINDS).optional(),
  integrationId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  status: z.string().trim().max(20).optional(),
});
