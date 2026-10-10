/**
 * Starts the device simulators for manual testing of discovery and monitoring:
 *   npx tsx apps/api/test/simulators/run.ts
 * SNMP agent: udp 127.0.0.1:16161, community "demo-public-ro", with 64-bit
 * interface counters that grow as if traffic were flowing (a made-up daily
 * curve plus noise) so the poller has something to measure.
 * RouterOS REST mock: http on a random port, user "dcim-ro", password "demo-pass"
 * (also answers /system/health with a power-consumption figure).
 * Redfish BMC mock: http://127.0.0.1:18080, user "root", password "demo-bmc-pass",
 * power wandering around 300 W.
 * APC metered PDU: udp 127.0.0.1:16162, community "demo-pdu-ro", 8 outlets.
 * These are simulators, not real devices; the traffic they report is invented.
 */
import { DEFAULT_SIM, startSnmpAgent } from './snmp-agent';
import { ROUTEROS_FIXTURE, startRouterOs } from './http-devices';
import { ROUTEROS_HEALTH, startRedfish } from './power-devices';

void (async () => {
  const agent = await startSnmpAgent(16161, undefined, { community: 'demo-public-ro', counters: 'hc' });
  const ros = await startRouterOs('dcim-ro', 'demo-pass', { ...ROUTEROS_FIXTURE, '/rest/system/health': ROUTEROS_HEALTH });
  const bmc = await startRedfish('root', 'demo-bmc-pass', { watts: 300, port: 18080 });
  const outletW = [180, 172, 95, 0, 240, 236, 60, 0];
  const pdu = await startSnmpAgent(16162, undefined, {
    community: 'demo-pdu-ro',
    pdu: { outlets: outletW.map((w, i) => ({ number: i + 1, name: `Outlet ${i + 1}`, watts: w })), totalHundredthsKw: Math.round(outletW.reduce((a, b) => a + b, 0) / 10) },
  });
  setInterval(() => {
    bmc.setWatts(Math.round(300 + 40 * Math.sin(Date.now() / 600_000) + Math.random() * 20));
    let total = 0;
    outletW.forEach((w, i) => {
      const v = w ? Math.round(w * (0.9 + Math.random() * 0.2)) : 0;
      total += v;
      pdu.setOutletWatts(i + 1, v);
    });
    pdu.setPduTotal(Math.round(total / 10));
  }, 5000);
  const started = Date.now();
  // Base load per port in bit/s (ether1 is a 1 Gbit/s uplink in the simulator).
  const profile: Record<number, { inBps: number; outBps: number }> = { 1: { inBps: 420e6, outBps: 160e6 }, 2: { inBps: 0, outBps: 0 }, 5: { inBps: 35e6, outBps: 22e6 } };
  const totals = new Map<number, { in: bigint; out: bigint; pin: bigint; pout: bigint }>();
  const step = () => {
    const t = Date.now();
    agent.setUptime(Math.floor((t - started) / 10) + 8_640_000);
    const daily = 0.65 + 0.35 * Math.sin(((t / 3600_000) % 24) * (Math.PI / 12));
    for (const i of DEFAULT_SIM.ifaces) {
      const p = profile[i.ifIndex];
      if (!p) continue;
      const c = totals.get(i.ifIndex) ?? { in: 10_000_000_000n, out: 4_000_000_000n, pin: 0n, pout: 0n };
      const noise = () => 0.85 + Math.random() * 0.3;
      const dIn = BigInt(Math.round((p.inBps * daily * noise() * 5) / 8));
      const dOut = BigInt(Math.round((p.outBps * daily * noise() * 5) / 8));
      c.in += dIn;
      c.out += dOut;
      c.pin += dIn / 900n;
      c.pout += dOut / 900n;
      totals.set(i.ifIndex, c);
      agent.setCounter(i.ifIndex, 'inOctets', c.in);
      agent.setCounter(i.ifIndex, 'outOctets', c.out);
      agent.setCounter(i.ifIndex, 'inPkts', c.pin);
      agent.setCounter(i.ifIndex, 'outPkts', c.pout);
    }
  };
  step();
  setInterval(step, 5000);
  process.stdout.write(
    `SNMP simulator on udp/127.0.0.1:16161 (community demo-public-ro), counters advance every 5 s\nRedfish BMC mock on http://127.0.0.1:${bmc.port} (root / demo-bmc-pass, scheme HTTP)\nAPC PDU simulator on udp/127.0.0.1:16162 (community demo-pdu-ro)\nRouterOS REST mock on http://127.0.0.1:${ros.port} (dcim-ro / demo-pass, use scheme HTTP)\nCtrl+C to stop.\n`,
  );
})();
