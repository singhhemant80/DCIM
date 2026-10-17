import type { BootKind, DetectedIso, InstallMode } from '@crapplet/shared';

/**
 * Works out how an ISO boots from the files inside it (plus a few small text
 * files the caller reads for us). Only well-known layouts are recognised; an
 * ISO that matches none is "unknown" and can still be used through virtual
 * media, interactively.
 */

export interface IsoListing {
  /** Paths inside the ISO, as listed (any case, no leading "./" or "/"). */
  paths: string[];
  /** Volume label from the primary volume descriptor. */
  volumeId: string | null;
  /** Reads a small text file from the ISO (null when missing). */
  read: (path: string) => Promise<string | null>;
}

export interface Detection extends DetectedIso {
  /** Paths (as listed in the ISO) of the kernel and initrd to extract, or 'tree' to extract everything. */
  extract: { kernel?: string; initrd?: string; tree?: boolean };
}

const both: InstallMode[] = ['automatic', 'interactive'];
const inter: InstallMode[] = ['interactive'];

export function normalisePath(p: string) {
  return p.replace(/^\.?\/+/, '').replace(/\/+$/, '');
}

const ver = (s: string | null | undefined) => /\b(\d+(?:\.\d+){1,2})\b/.exec(s ?? '')?.[1] ?? null;

/** Simple INI reader for .treeinfo (sections → key → value). */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let cur = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      cur = sec[1]!.trim().toLowerCase();
      out[cur] ??= {};
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (kv) (out[cur] ??= {})[kv[1]!.trim().toLowerCase()] = kv[2]!.trim();
  }
  return out;
}

export async function detectIso(l: IsoListing): Promise<Detection> {
  const byLower = new Map<string, string>();
  for (const p of l.paths) byLower.set(normalisePath(p).toLowerCase(), normalisePath(p));
  const has = (p: string) => byLower.has(p.toLowerCase());
  const real = (p: string) => byLower.get(p.toLowerCase()) ?? p;
  const first = (...ps: string[]) => ps.find(has);
  const read = async (p: string) => (has(p) ? l.read(real(p)) : null);
  const vol = l.volumeId?.trim() || null;
  const base = (bootKind: BootKind, extra: Partial<Detection>): Detection => ({
    bootKind,
    label: vol,
    version: null,
    codename: null,
    arch: null,
    methods: ['redfish_virtual_media'],
    modes: { pxe: [], redfish_virtual_media: inter },
    uefiOnly: false,
    notes: [],
    extract: {},
    ...extra,
  });

  // Windows: the ISO9660 side of a Windows ISO only has a README pointing to its UDF file system,
  // or (hybrid builds) the sources/ folder itself.
  const readme = await read('README.TXT');
  if (first('sources/install.wim', 'sources/install.esd', 'sources/boot.wim') || (l.paths.length <= 3 && readme && /UDF/i.test(readme))) {
    return base('windows', {
      label: vol ?? 'Windows',
      notes: ['Windows Setup cannot install over plain PXE: NexoraDC mounts this ISO through the BMC (virtual media) and you finish Setup in the console.'],
    });
  }

  // Ubuntu live server (20.04 and later): casper/vmlinuz + casper/initrd; the installer fetches the whole ISO (url=).
  const info = (await read('.disk/info'))?.trim() ?? null;
  const ubuntuKernel = first('casper/vmlinuz', 'casper/hwe-vmlinuz');
  const ubuntuInitrd = first('casper/initrd', 'casper/initrd.lz', 'casper/initrd.gz', 'casper/hwe-initrd');
  if (ubuntuKernel && ubuntuInitrd && (!info || /ubuntu/i.test(info))) {
    return base('ubuntu', {
      label: info?.replace(/\s*\(\d{8}(\.\d+)?\)\s*$/, '') ?? vol,
      version: ver(info),
      codename: /"([^"]+)"/.exec(info ?? '')?.[1] ?? null,
      arch: /\b(amd64|arm64)\b/.exec(info ?? '')?.[1] ?? null,
      methods: ['pxe', 'redfish_virtual_media'],
      modes: { pxe: both, redfish_virtual_media: inter },
      notes: ['The installer downloads the whole ISO into memory over HTTP: the server needs a few GB more RAM than the ISO size.'],
      extract: { kernel: real(ubuntuKernel), initrd: real(ubuntuInitrd) },
    });
  }

  // Debian: the CD's own installer expects the CD, so network installs use the matching netboot
  // installer from the Debian mirror (the server needs internet access during the install).
  if (info && /debian/i.test(info) && first('install.amd/vmlinuz', 'install/vmlinuz')) {
    const codename = /"([^"]+)"/.exec(info)?.[1]?.toLowerCase() ?? null;
    return base('debian', {
      label: info.replace(/\s*-\s*Official.*$/i, '').trim() || vol,
      version: ver(info),
      codename,
      arch: /\b(amd64|arm64|i386)\b/.exec(info)?.[1] ?? null,
      methods: codename ? ['pxe', 'redfish_virtual_media'] : ['redfish_virtual_media'],
      modes: { pxe: codename ? both : [], redfish_virtual_media: inter },
      notes: codename
        ? [`Network installs use the Debian ${codename} netboot installer from deb.debian.org (checked against its SHA256SUMS) and install packages from the Debian mirror: the server needs internet access.`]
        : ['The Debian release name was not found in the ISO, so network install is not available; use virtual media.'],
    });
  }

  // Proxmox VE: boot/linux26 + boot/initrd.img; the installer finds the ISO inside its initrd.
  if (first('boot/linux26') && first('boot/initrd.img') && (has('.cd-info') || has('proxmox') || /proxmox|pve/i.test(vol ?? ''))) {
    const cd = parseIni(`[x]\n${(await read('.cd-info')) ?? ''}`).x ?? {};
    const release = cd.release ?? ver(vol);
    return base('proxmox', {
      label: `Proxmox VE${release ? ` ${release}` : ''}`,
      version: release,
      arch: 'amd64',
      methods: ['pxe', 'redfish_virtual_media'],
      modes: { pxe: inter, redfish_virtual_media: inter },
      notes: [
        'The installer is loaded into memory together with the whole ISO: the server needs at least 4 GB RAM.',
        'Proxmox is installed interactively: an unattended Proxmox install needs an ISO prepared with proxmox-auto-install-assistant.',
      ],
      extract: { kernel: real('boot/linux26'), initrd: real('boot/initrd.img') },
    });
  }

  // RHEL family: .treeinfo + images/pxeboot; Anaconda installs from the extracted tree (inst.repo).
  const tree = await read('.treeinfo');
  const pxeKernel = first('images/pxeboot/vmlinuz');
  const pxeInitrd = first('images/pxeboot/initrd.img');
  if (tree && pxeKernel && pxeInitrd) {
    const t = parseIni(tree);
    const name = t.release?.name ?? t.general?.family ?? t.product?.name ?? null;
    const version = t.release?.version ?? t.general?.version ?? t.product?.version ?? null;
    return base('rhel', {
      label: [name, version].filter(Boolean).join(' ') || vol,
      version,
      arch: t.tree?.arch ?? t.general?.arch ?? null,
      methods: ['pxe', 'redfish_virtual_media'],
      modes: { pxe: both, redfish_virtual_media: inter },
      notes: [],
      extract: { kernel: real(pxeKernel), initrd: real(pxeInitrd), tree: true },
    });
  }

  // VMware ESXi: boot.cfg + efi/boot/bootx64.efi; network boot through iPXE is UEFI only.
  if (has('boot.cfg') && has('efi/boot/bootx64.efi') && has('b.b00')) {
    const cfg = (await read('boot.cfg')) ?? '';
    const title = /^title=(.*)$/m.exec(cfg)?.[1]?.trim();
    return base('esxi', {
      label: vol ?? title ?? 'VMware ESXi',
      version: ver(vol) ?? ver(title),
      arch: 'x86_64',
      methods: ['pxe', 'redfish_virtual_media'],
      modes: { pxe: both, redfish_virtual_media: inter },
      uefiOnly: true,
      notes: ['ESXi network boot works on servers booting in UEFI mode.'],
      extract: { tree: true },
    });
  }

  return base('unknown', { notes: ['NexoraDC does not recognise this ISO, so it cannot be network-booted. It can still be mounted through the BMC (virtual media) and installed interactively.'] });
}
