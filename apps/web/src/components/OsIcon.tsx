import {
  siAlmalinux,
  siAlpinelinux,
  siArchlinux,
  siCentos,
  siCpanel,
  siDebian,
  siFedora,
  siFreebsd,
  siGentoo,
  siKalilinux,
  siLinux,
  siLinuxmint,
  siMikrotik,
  siNetbsd,
  siOpenbsd,
  siOpensuse,
  siOpnsense,
  siPfsense,
  siProxmox,
  siRedhat,
  siRockylinux,
  siSuse,
  siUbuntu,
  siVmware,
  type SimpleIcon,
} from 'simple-icons';
import { cx } from './ui';

/**
 * The operating system of a VM as a small icon, recognised from the name the
 * hypervisor reports (e.g. "ubuntu-20.04-x86_64", "AlmaLinux 9", "win2022").
 * Distribution icons come from Simple Icons (CC0; trademarks belong to their
 * owners). There is no Windows icon there, so Windows gets a plain badge.
 */
const RULES: [RegExp, SimpleIcon | 'windows', string][] = [
  [/win(dows)?[\s_-]*(server|srv|\d)|^win|windows/i, 'windows', 'Windows'],
  [/ubuntu/i, siUbuntu, 'Ubuntu'],
  [/debian/i, siDebian, 'Debian'],
  [/alma/i, siAlmalinux, 'AlmaLinux'],
  [/rocky/i, siRockylinux, 'Rocky Linux'],
  [/cent\s*os/i, siCentos, 'CentOS'],
  [/\brhel\b|red\s*hat/i, siRedhat, 'Red Hat Enterprise Linux'],
  [/fedora/i, siFedora, 'Fedora'],
  [/opensuse/i, siOpensuse, 'openSUSE'],
  [/\bsles\b|suse/i, siSuse, 'SUSE'],
  [/mint/i, siLinuxmint, 'Linux Mint'],
  [/kali/i, siKalilinux, 'Kali Linux'],
  [/arch/i, siArchlinux, 'Arch Linux'],
  [/alpine/i, siAlpinelinux, 'Alpine Linux'],
  [/gentoo/i, siGentoo, 'Gentoo'],
  [/freebsd/i, siFreebsd, 'FreeBSD'],
  [/openbsd/i, siOpenbsd, 'OpenBSD'],
  [/netbsd/i, siNetbsd, 'NetBSD'],
  [/pfsense/i, siPfsense, 'pfSense'],
  [/opnsense/i, siOpnsense, 'OPNsense'],
  [/mikrotik|routeros|\bchr\b/i, siMikrotik, 'MikroTik RouterOS'],
  [/proxmox|\bpve\b/i, siProxmox, 'Proxmox VE'],
  [/esxi|vmware/i, siVmware, 'VMware ESXi'],
  [/cpanel/i, siCpanel, 'cPanel'],
  [/linux|oracle|cloudlinux|eurolinux|virtuozzo/i, siLinux, 'Linux'],
];

export function osInfo(osName: string | null | undefined) {
  if (!osName) return null;
  for (const [re, icon, label] of RULES) if (re.test(osName)) return { icon, label };
  return null;
}

export function OsIcon({ osName, size = 20, className }: { osName: string | null | undefined; size?: number; className?: string }) {
  const os = osInfo(osName);
  const base = 'inline-flex shrink-0 items-center justify-center rounded-md';
  const box = cx(base, 'bg-white ring-1 ring-black/10', className);
  const style = { width: size + 8, height: size + 8 };
  if (!os)
    return (
      <span className={box} style={style} title={osName ?? 'Operating system not reported'} aria-label={osName ?? 'Operating system not reported'} role="img">
        <svg viewBox="0 0 24 24" width={size * 0.8} height={size * 0.8} fill="none" stroke="#8a93a6" strokeWidth="1.8" aria-hidden>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </svg>
      </span>
    );
  if (os.icon === 'windows')
    return (
      <span className={cx(base, className)} style={{ ...style, background: '#0b63c4' }} title={osName ?? 'Windows'} aria-label="Windows" role="img">
        <span className="font-semibold text-white" style={{ fontSize: Math.max(8, size * 0.42), letterSpacing: '-0.02em' }}>
          Win
        </span>
      </span>
    );
  return (
    <span className={box} style={style} title={osName ?? os.label} aria-label={os.label} role="img">
      <svg viewBox="0 0 24 24" width={size} height={size} fill={`#${os.icon.hex}`} aria-hidden>
        <path d={os.icon.path} />
      </svg>
    </span>
  );
}
