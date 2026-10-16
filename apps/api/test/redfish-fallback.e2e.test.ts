import { describe, expect, it } from 'vitest';
import { redfishAdapter } from '../src/worker/adapters/redfish';
import { deviceErrorText } from '../src/worker/adapters/http';
import { startRedfish } from './simulators/power-devices';

const target = (port: number, password = 'pw') => ({ host: '127.0.0.1', port, username: 'root', params: { scheme: 'http' as const }, secret: { password } }) as never;

describe('Redfish when the BMC fails on its system list', () => {
  it('reads the system at the known iDRAC path and says the list failed', async () => {
    const sim = await startRedfish('root', 'pw', { systemsError: 500 });
    try {
      const r = await redfishAdapter().test(target(sim.port));
      expect(r.ok).toBe(true);
      expect(r.message).toMatch(/^Connected: Dell/);
      expect(r.message).toMatch(/system list failed \(HTTP 500 from \/redfish\/v1\/Systems: Unable to complete the operation because of an internal error\. Retry the operation\. If the issue persists, reset iDRAC\.\)/);
      expect(r.message).toMatch(/System\.Embedded\.1 was read directly/);
      // Only GET requests went to the BMC.
      expect(sim.requests.every((q) => q.method === 'GET')).toBe(true);
    } finally {
      await sim.close();
    }
  });

  it('hardware inventory still works and carries the note as a warning', async () => {
    const sim = await startRedfish('root', 'pw', { systemsError: 500 });
    try {
      const inv = await redfishAdapter().hardware!(target(sim.port));
      expect(inv.memory.length).toBeGreaterThan(0);
      expect(inv.warnings.join('\n')).toMatch(/system list failed/);
    } finally {
      await sim.close();
    }
  });

  it('a wrong password is still an authentication error, not a fallback', async () => {
    const sim = await startRedfish('root', 'pw', { systemsError: 500 });
    try {
      await expect(redfishAdapter().test(target(sim.port, 'wrong'))).rejects.toThrow(/Authentication failed \(HTTP 401\)/);
    } finally {
      await sim.close();
    }
  });

  it('follows a redirect on the same host (e.g. /Systems to /Systems/)', async () => {
    const sim = await startRedfish('root', 'pw', { redirectSystems: 'slash' });
    try {
      const r = await redfishAdapter().test(target(sim.port));
      expect(r.ok).toBe(true);
      expect(r.message).not.toMatch(/Note/);
    } finally {
      await sim.close();
    }
  });

  it('a redirect to HTTPS is reported with what to change, not followed', async () => {
    const sim = await startRedfish('root', 'pw', { redirectSystems: 'https' });
    try {
      // The known system path still answers, so the test connects and says why the list failed.
      const r = await redfishAdapter().test(target(sim.port));
      expect(r.message).toMatch(/redirected \(HTTP 301\) to https:\/\/127\.0\.0\.1:8443\/redfish\/v1\/Systems; set this credential's protocol to HTTPS and port 8443/);
      expect(sim.requests.some((q) => q.url.includes('8443'))).toBe(false);
    } finally {
      await sim.close();
    }
  });

  it('accepts absolute member links, using only their path on the credential host', async () => {
    const sim = await startRedfish('root', 'pw', { absoluteLinks: true });
    try {
      const r = await redfishAdapter().test(target(sim.port));
      expect(r.ok).toBe(true);
      expect(r.message).not.toMatch(/Note/);
    } finally {
      await sim.close();
    }
  });

  it('device error text is taken from the Redfish body, single line and capped', () => {
    expect(deviceErrorText(JSON.stringify({ error: { message: 'General', '@Message.ExtendedInfo': [{ Message: 'Bad\nthing.', Resolution: 'Reset.' }] } }))).toBe('Bad thing. Reset.');
    expect(deviceErrorText(JSON.stringify({ error: { message: 'x'.repeat(400) } }))!.length).toBe(240);
    expect(deviceErrorText('<html>500</html>')).toBeNull();
    expect(deviceErrorText(JSON.stringify({ error: 'Not found' }))).toBe('Not found');
  });
});
