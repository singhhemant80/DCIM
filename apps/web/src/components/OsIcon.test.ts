import { describe, expect, it } from 'vitest';
import { osInfo } from './OsIcon';

describe('osInfo', () => {
  it('recognises the OS from the name the hypervisor reports', () => {
    const label = (s: string | null) => osInfo(s)?.label ?? null;
    expect(label('ubuntu-20.04-x86_64')).toBe('Ubuntu');
    expect(label('debian-12-x86_64')).toBe('Debian');
    expect(label('AlmaLinux 9.4')).toBe('AlmaLinux');
    expect(label('rocky-9-x86_64')).toBe('Rocky Linux');
    expect(label('centos-7.9-x86_64')).toBe('CentOS');
    expect(label('rhel-8')).toBe('Red Hat Enterprise Linux');
    expect(label('win2022-x86_64')).toBe('Windows');
    expect(label('Windows Server 2019')).toBe('Windows');
    expect(label('windows-10-pro')).toBe('Windows');
    expect(label('cloudlinux-8')).toBe('Linux');
    expect(label('proxmox-ve-8')).toBe('Proxmox VE');
    expect(label('something-unknown')).toBeNull();
    expect(label(null)).toBeNull();
  });
});
