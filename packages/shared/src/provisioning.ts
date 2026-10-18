import { z } from 'zod';
import { dateRangeFields, paginationSchema } from './schemas';

/* ------------------------------------------------------------------ jobs */

export const JOB_KINDS = ['power_action', 'os_install', 'image_verify', 'guest_action', 'image_process', 'guest_reinstall'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const JOB_KIND_LABELS: Record<JobKind, string> = {
  power_action: 'Power action',
  os_install: 'OS installation',
  image_verify: 'Image checksum',
  guest_action: 'VM action',
  image_process: 'ISO preparation',
  guest_reinstall: 'VM reinstall',
};

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
  /** Jobs created on these days. */
  ...dateRangeFields,
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
export const TEMPLATE_KINDS = ['kickstart', 'preseed', 'autoinstall', 'esxi', 'none'] as const;
export const TEMPLATE_KIND_LABELS: Record<(typeof TEMPLATE_KINDS)[number], string> = {
  kickstart: 'Kickstart (RHEL, Alma, Rocky)',
  preseed: 'Preseed (Debian)',
  autoinstall: 'Autoinstall / cloud-init (Ubuntu)',
  esxi: 'ESXi kickstart (ks.cfg)',
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

/* ------------------------------------------------------------------ uploaded ISOs */

/** How an uploaded ISO boots, found by looking inside it. */
export const BOOT_KINDS = ['ubuntu', 'debian', 'rhel', 'proxmox', 'esxi', 'windows', 'unknown'] as const;
export type BootKind = (typeof BOOT_KINDS)[number];
export const BOOT_KIND_LABELS: Record<BootKind, string> = {
  ubuntu: 'Ubuntu (live server)',
  debian: 'Debian',
  rhel: 'RHEL family (Rocky, Alma, CentOS, RHEL, Fedora, Oracle)',
  proxmox: 'Proxmox VE',
  esxi: 'VMware ESXi',
  windows: 'Windows',
  unknown: 'Not recognised',
};
export const UPLOAD_STATUSES = ['uploading', 'processing', 'ready', 'failed'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];
export const INSTALL_MODES = ['automatic', 'interactive'] as const;
export type InstallMode = (typeof INSTALL_MODES)[number];
export const INSTALL_MODE_LABELS: Record<InstallMode, string> = { automatic: 'Automatic (unattended)', interactive: 'Interactive (finish in the console)' };

/** What NexoraDC found inside an uploaded ISO and can do with it. */
export interface DetectedIso {
  bootKind: BootKind;
  /** e.g. "Ubuntu 24.04.1 LTS", from the ISO's own label. */
  label: string | null;
  version: string | null;
  codename: string | null;
  arch: string | null;
  /** Install methods that work with this ISO. */
  methods: ('pxe' | 'redfish_virtual_media')[];
  /** Modes per method. */
  modes: { pxe: InstallMode[]; redfish_virtual_media: InstallMode[] };
  /** Network boot needs UEFI (ESXi). */
  uefiOnly: boolean;
  notes: string[];
}

/** Largest ISO accepted (64 GiB). */
export const MAX_ISO_BYTES = 64 * 1024 ** 3;
/** Upload chunk size the web client uses; the server accepts up to twice this per request. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

export const isoUploadStartSchema = z.object({
  name: z.string().trim().min(1).max(120),
  fileName: z
    .string()
    .trim()
    .min(5)
    .max(255)
    .regex(/^[^/\\\0]+\.iso$/i, 'An .iso file'),
  size: z
    .number()
    .int()
    .min(1024 * 1024)
    .max(MAX_ISO_BYTES),
  /** Optional: the SHA-256 published by the vendor; the upload is rejected if it differs. */
  expectedSha256: sha256.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type IsoUploadStart = z.infer<typeof isoUploadStartSchema>;

/** Template and install settings of an uploaded image (its files come from the upload). */
export const uploadedImageSchema = z.object({
  name: z.string().trim().min(1).max(120),
  templateKind: z.enum(TEMPLATE_KINDS),
  template: z.string().max(100_000).nullable().optional(),
  /** Extra kernel arguments appended to the built-in ones. */
  bootArgs: z.string().trim().max(2000).nullable().optional(),
  enabled: z.boolean().default(true),
  notes: z.string().trim().max(2000).nullable().optional(),
});

/* ------------------------------------------------------------------ PXE service */

const cidr = z
  .string()
  .trim()
  .refine((v) => {
    const [a, l, ...rest] = v.split('/');
    if (rest.length || !a || l === undefined || !/^\d{1,3}$/.test(l)) return false;
    const four = /^(\d{1,3}\.){3}\d{1,3}$/.test(a) && a.split('.').every((o) => Number(o) <= 255);
    const six = !four && /^[0-9a-f:]+$/i.test(a) && a.includes(':');
    return (four && Number(l) <= 32) || (six && Number(l) <= 128);
  }, 'A network like 10.20.0.0/24');
const ipv4 = z
  .string()
  .trim()
  .regex(/^(\d{1,3}\.){3}\d{1,3}$/, 'An IPv4 address')
  .refine((a) => a.split('.').every((o) => Number(o) <= 255), 'An IPv4 address');

export const PXE_MODES = ['proxy', 'dhcp', 'external'] as const;
export type PxeMode = (typeof PXE_MODES)[number];
export const PXE_MODE_LABELS: Record<PxeMode, string> = {
  proxy: 'Your DHCP gives addresses; NexoraDC adds the boot details (same network)',
  dhcp: 'NexoraDC gives addresses to servers being installed (same network or DHCP relay)',
  external: 'Your DHCP server points to NexoraDC (TFTP only)',
};

export const pxeRangeSchema = z.object({
  /** The network the servers boot on, e.g. 163.52.252.0/24. */
  network: cidr,
  start: ipv4,
  end: ipv4,
  gateway: ipv4.nullable().optional(),
  dns: z.array(ipv4).max(3).default([]),
});

export const pxeSettingsSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(PXE_MODES),
    /** Network interface the PXE service listens on (empty: all). */
    interface: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.:@-]{1,32}$/, 'An interface name like eth0 or ens18')
      .nullable()
      .optional(),
    /** This server's address as the booting servers reach it (TFTP "next server"). */
    serverAddress: ipv4,
    /** Proxy mode: the network(s) where your DHCP server hands out addresses. */
    proxyNetworks: z.array(cidr).max(16).default([]),
    /** NexoraDC DHCP mode: address ranges for servers being installed. */
    ranges: z.array(pxeRangeSchema).max(16).default([]),
    /** URL the installer uses to reach NexoraDC over HTTP, e.g. http://163.52.252.10 (default: http://<server address>). */
    bootBaseUrl: z
      .string()
      .trim()
      .url()
      .max(200)
      .refine((u) => /^http:\/\/[^/@]+\/?$/.test(u), 'http:// and the host only, e.g. http://10.0.0.5 (network boot cannot use https)')
      .transform((u) => u.replace(/\/$/, ''))
      .nullable()
      .optional(),
    /** Networks allowed to fetch boot scripts, install files and configs (added to the built-in list). */
    allowNetworks: z.array(cidr).max(32).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'proxy' && !v.proxyNetworks.length) ctx.addIssue({ code: 'custom', path: ['proxyNetworks'], message: 'Add the network the servers boot on' });
    if (v.mode === 'dhcp' && !v.ranges.length) ctx.addIssue({ code: 'custom', path: ['ranges'], message: 'Add at least one address range' });
  });
export type PxeSettingsInput = z.infer<typeof pxeSettingsSchema>;

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
    /** Automatic (template-driven) or interactive (the installer is started; finish it in the console). */
    mode: z.enum(INSTALL_MODES).default('automatic'),
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
    sshKeys: z
      .array(
        z
          .string()
          .trim()
          .regex(/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( [\w.@+=:-]{1,200})?$/, 'An OpenSSH public key (comment: letters, digits and . @ + = : - _ only)'),
      )
      .max(10)
      .default([]),
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
    tokenId: z
      .string()
      .trim()
      .regex(/^[^\s!@]+@[^\s!@]+![A-Za-z0-9_-]+$/, 'Like dcim@pve!sync'),
    tokenSecret: z.string().trim().min(8).max(200),
    /** Optional second token allowed to start/stop VMs (a separate, narrower role). Without it, VM actions are off. */
    actionTokenId: z
      .string()
      .trim()
      .regex(/^[^\s!@]+@[^\s!@]+![A-Za-z0-9_-]+$/, 'Like dcim@pve!actions')
      .nullable()
      .optional(),
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
/** An OS template the hypervisor can install (from the read-only sync). */
export interface VirtTemplate {
  osid: number;
  name: string;
  distro: string | null;
  /** Virtualization type the template is for (e.g. kvm, proxk, openvz), as the panel names it. */
  type: string | null;
}
/**
 * Reinstall a VM from one of the hypervisor's OS templates (Virtualizor "Rebuild VPS").
 * Erases the VM's disk. The root password goes to the hypervisor once and is not kept.
 */
export const guestReinstallSchema = z
  .object({
    osid: z.number().int().positive(),
    password: z.string().min(8, 'At least 8 characters').max(128),
    confirm: z.string().trim().min(1).max(200),
    /** Only the primary disk is formatted (KVM / Proxmox KVM / Xen HVM); other disks are kept. */
    formatPrimaryOnly: z.boolean().default(false),
  })
  .refine((v) => !/[\u0000-\u001f]/.test(v.password), { message: 'The password cannot contain control characters', path: ['password'] });

export const guestAssignSchema = z.object({ customerId: z.string().uuid().nullable() });
export const hostMapSchema = z.object({ deviceId: z.string().uuid().nullable() });
export const GUEST_SORTS = ['name', 'status', 'cpus', 'memory', 'disk', 'server', 'customer'] as const;
export const guestListQuerySchema = paginationSchema.extend({
  kind: z.enum(VIRT_KINDS).optional(),
  integrationId: z.string().uuid().optional(),
  /** Only the VMs on this hypervisor node. */
  hostId: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  /** A status as stored (running, stopped, suspended, network_suspended, locked…), "unknown", or "missing" (no longer reported). */
  status: z.string().trim().max(30).optional(),
  /** Staff: a customer's VMs, or "own" for the organization's own (no customer). */
  customerId: z.union([z.string().uuid(), z.literal('own')]).optional(),
  virtType: z.string().trim().max(30).optional(),
  /** Exact OS name as the hypervisor reports it, or "none" for VMs without one. */
  osName: z.string().trim().max(200).optional(),
  sort: z.enum(GUEST_SORTS).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});
