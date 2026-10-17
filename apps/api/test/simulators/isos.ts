import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Small ISOs laid out like real installer media (same paths and info files),
 * built with xorriso. The kernels and initrds are random bytes: these test
 * detection, extraction and serving, not booting. Each ISO carries 1 MiB of
 * padding because uploads must be at least 1 MiB.
 */
export function haveIsoTools(): boolean {
  try {
    execFileSync('xorriso', ['-version'], { stdio: 'ignore' });
    execFileSync('bsdtar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface TestIso {
  path: string;
  files: Record<string, Buffer>;
}

export function buildIso(label: string, files: Record<string, string | Buffer>, opts: { rockRidge?: boolean } = {}): TestIso {
  const dir = mkdtempSync(join(tmpdir(), 'cdcim-iso-'));
  const root = join(dir, 'root');
  const out: Record<string, Buffer> = {};
  for (const [p, c] of Object.entries({ ...files, 'PADDING.BIN': randomBytes(1024 * 1024 + 4096) })) {
    const f = join(root, p);
    mkdirSync(dirname(f), { recursive: true });
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    writeFileSync(f, b);
    out[p] = b;
  }
  const iso = join(dir, `${label}.iso`);
  execFileSync('xorriso', ['-as', 'mkisofs', '-quiet', '-o', iso, '-V', label, ...(opts.rockRidge === false ? [] : ['-R', '-J']), root], { stdio: 'ignore' });
  return { path: iso, files: out };
}

export const ubuntuIso = () =>
  buildIso('Ubuntu-Server 24.04.1 LTS amd64', {
    '.disk/info': 'Ubuntu-Server 24.04.1 LTS "Noble Numbat" - Release amd64 (20240827)',
    'casper/vmlinuz': randomBytes(40_000),
    'casper/initrd': randomBytes(60_000),
    'boot/grub/grub.cfg': 'menuentry "Try or Install Ubuntu Server" {}',
  });

export const rockyIso = () =>
  buildIso('Rocky-9-4-x86_64-dvd', {
    '.treeinfo': '[header]\ntype = productmd.treeinfo\nversion = 1.2\n\n[release]\nname = Rocky Linux\nshort = Rocky\nversion = 9.4\n\n[tree]\narch = x86_64\nplatforms = x86_64,xen\n',
    'images/pxeboot/vmlinuz': randomBytes(30_000),
    'images/pxeboot/initrd.img': randomBytes(50_000),
    'BaseOS/Packages/b/bash-5.1.8-9.el9.x86_64.rpm': randomBytes(20_000),
    'BaseOS/repodata/repomd.xml': '<repomd/>',
  });

export const debianIso = () =>
  buildIso('Debian 12.7.0 amd64 n', {
    '.disk/info': 'Debian GNU/Linux 12.7.0 "Bookworm" - Official amd64 NETINST with firmware 20240831-10:38',
    'install.amd/vmlinuz': randomBytes(20_000),
    'install.amd/initrd.gz': randomBytes(20_000),
  });

export const proxmoxIso = () =>
  buildIso('PVE', {
    '.cd-info': 'PRODUCT=pve\nPRODUCTLONG=Proxmox VE\nRELEASE=8.2\nISORELEASE=1\n',
    'boot/linux26': randomBytes(30_000),
    'boot/initrd.img': randomBytes(30_001),
    'proxmox/packages/README': 'packages',
  });

export const esxiIso = () =>
  buildIso('ESXI-8.0U2-22380479-STANDARD', {
    'BOOT.CFG': 'bootstate=0\ntitle=Loading ESXi installer\ntimeout=5\nprefix=\nkernel=/b.b00\nkernelopt=runweasel cdromBoot\nmodules=/jumpstrt.gz --- /useropts.gz --- /features.gz\nbuild=8.0.2-0.0.22380479\nupdated=0\n',
    'B.B00': randomBytes(10_000),
    'JUMPSTRT.GZ': randomBytes(5_000),
    'EFI/BOOT/BOOTX64.EFI': randomBytes(8_000),
  });

/** The ISO9660 side of a Windows ISO: only a README about the UDF file system. */
export const windowsIso = () =>
  buildIso('SSS_X64FREE_EN-US_DV9', { 'README.TXT': 'This disc contains a "UDF" file system and requires an operating system that supports the ISO-13346 "UDF" file system specification.' }, { rockRidge: false });
