import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { accessPort, tcpProbe } from './virt-live';

describe('remote access check', () => {
  it('RDP for Windows (by OS, or by name when the OS is unknown), SSH otherwise', () => {
    expect(accessPort({ osName: 'win2019-x86_64', name: 'x' })).toBe(3389);
    expect(accessPort({ osName: 'Windows Server 2022', name: 'x' })).toBe(3389);
    expect(accessPort({ osName: null, name: 'windowsvps' })).toBe(3389);
    expect(accessPort({ osName: 'ubuntu-20.04-x86_64', name: 'windows-like-name' })).toBe(22);
    expect(accessPort({ osName: null, name: 'vps25.mytrading.com' })).toBe(22);
  });

  it('a TCP handshake: open, refused, no answer', async () => {
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const open = await tcpProbe('127.0.0.1', port, 1000);
    expect(open.ok).toBe(true);
    expect(open.ms).not.toBeNull();
    server.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await tcpProbe('127.0.0.1', port, 1000)).toMatchObject({ ok: false, error: 'Refused' });
    // TEST-NET-1 is never routed: either no answer within the time limit or unreachable.
    const t0 = Date.now();
    const silent = await tcpProbe('192.0.2.1', 22, 300);
    expect(silent.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
