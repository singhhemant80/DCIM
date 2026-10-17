import type { BootKind, InstallMode } from '@crapplet/shared';
import type { InstallVars } from '../template';

/**
 * iPXE scripts for uploaded ISOs, per OS. Every URL is under the job's
 * token, so it works only while that install runs. Kernel arguments come
 * from here plus the image's own extra boot arguments.
 */
export interface RecipeInput {
  kind: BootKind;
  mode: InstallMode;
  /** `<base>/api/v1/boot/files/<token>` */
  files: string;
  /** `<base>/api/v1/boot/config/<token>` */
  configUrl: string;
  vars: InstallVars;
  extraArgs: string;
  label: string;
}

export class RecipeError extends Error {}

const lines = (...l: (string | false | null | undefined)[]) => [...l.filter((x): x is string => typeof x === 'string'), ''].join('\n');
const args = (...a: (string | false | null | undefined)[]) => a.filter((x): x is string => !!x && !!x.trim()).join(' ');
/** Kernel arguments must not break the iPXE line or smuggle iPXE settings expansion. */
const safe = (v: string) => {
  if (/[\r\n]|\$\{/.test(v)) throw new RecipeError('Boot arguments contain a line break or "${"');
  return v;
};

function kernelBoot(i: RecipeInput, kernelArgs: string, initrd = `${i.files}/initrd`) {
  const a = safe(args(kernelArgs, i.extraArgs));
  return lines('#!ipxe', `echo NexoraDC: ${i.mode} install of ${i.label} for ${i.vars.hostname}`, `kernel ${i.files}/kernel initrd=initrd ${a}`.trimEnd(), `initrd --name initrd ${initrd}`, 'boot || goto failed', ':failed', 'echo NexoraDC: the installer could not be started', 'sleep 10', 'exit');
}

export function bootScript(i: RecipeInput): string {
  const auto = i.mode === 'automatic';
  const v = i.vars;
  switch (i.kind) {
    case 'ubuntu':
      // The installer downloads the ISO into memory (url=); cloud-config-url=/dev/null stops cloud-init fetching it a second time.
      return kernelBoot(i, args('ip=dhcp', `url=${i.files}/iso`, 'cloud-config-url=/dev/null', 'fsck.mode=skip', auto && `autoinstall ds=nocloud-net;s=${i.configUrl}/`));
    case 'rhel':
      return kernelBoot(i, args(`inst.repo=${i.files}/tree/`, 'ip=dhcp', auto && `inst.ks=${i.configUrl}`));
    case 'debian': {
      // A static address is given on the command line so the installer has its final address before fetching the preseed.
      const st =
        auto && v.static
          ? args('netcfg/disable_autoconfig=true', `netcfg/get_ipaddress=${v.ip}`, `netcfg/get_netmask=${v.netmask}`, v.gateway && `netcfg/get_gateway=${v.gateway}`, v.nameservers && `netcfg/get_nameservers=${v.nameservers.split(' ')[0]}`, 'netcfg/confirm_static=true')
          : '';
      return kernelBoot(i, args(auto && `auto=true priority=critical url=${i.configUrl} netcfg/choose_interface=auto netcfg/get_hostname=${v.shortname} netcfg/get_domain=${v.domain || 'localdomain'}`, st));
    }
    case 'proxmox':
      // The initrd is served with the whole ISO appended (/proxmox.iso), which the installer looks for.
      return kernelBoot(i, 'ramdisk_size=16777216 rw quiet splash=silent', `${i.files}/proxmox-initrd`);
    case 'esxi':
      return lines(
        '#!ipxe',
        `echo NexoraDC: ${i.mode} install of ${i.label} for ${v.hostname}`,
        'iseq ${platform} efi || goto bios',
        `chain ${i.files}/tree/efi/boot/bootx64.efi -c ${i.files}/esxi-boot.cfg || goto failed`,
        ':bios',
        'echo NexoraDC: ESXi network install needs the server to boot in UEFI mode',
        'sleep 10',
        'exit',
        ':failed',
        'echo NexoraDC: the ESXi installer could not be started',
        'sleep 10',
        'exit',
      );
    default:
      throw new RecipeError(`${i.label} cannot be network-booted`);
  }
}

/**
 * ESXi's boot.cfg rewritten for HTTP: module paths made relative to `prefix`
 * (the extracted tree), the CD-only option dropped and, for an automatic
 * install, the kickstart URL and boot NIC added.
 */
export function esxiBootCfg(original: string, i: { files: string; mode: InstallMode; configUrl: string; mac: string; extraArgs: string }): string {
  const out: string[] = [];
  let sawPrefix = false;
  for (const raw of original.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const m = /^([a-zA-Z]+)=(.*)$/.exec(line);
    if (!m) {
      if (line) out.push(line);
      continue;
    }
    const [, key, val] = m as unknown as [string, string, string];
    if (key === 'prefix') {
      sawPrefix = true;
      out.push(`prefix=${i.files}/tree/`);
    } else if (key === 'kernel') out.push(`kernel=${val.replace(/^\/+/, '')}`);
    else if (key === 'modules')
      out.push(
        `modules=${val
          .split(' --- ')
          .map((x) => x.trim().replace(/^\/+/, ''))
          .join(' --- ')}`,
      );
    else if (key === 'kernelopt') {
      const opts = val.split(/\s+/).filter((o) => o && !/^cdromBoot$/i.test(o) && !/^ks=/i.test(o));
      if (i.mode === 'automatic') opts.push(`ks=${i.configUrl}`, `netdevice=${i.mac}`, 'bootproto=dhcp');
      if (i.extraArgs) opts.push(i.extraArgs);
      out.push(`kernelopt=${opts.join(' ')}`);
    } else out.push(line);
  }
  if (!sawPrefix) out.unshift(`prefix=${i.files}/tree/`);
  return `${out.join('\n')}\n`;
}
