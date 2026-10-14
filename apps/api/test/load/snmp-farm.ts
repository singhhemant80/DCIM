/**
 * Child process for the poller load test: N simulated SNMP agents (net-snmp,
 * UDP on 127.0.0.1), each with P interfaces whose 64-bit counters grow every
 * second. Kept out of the poller's process so its CPU is not counted there.
 *   tsx snmp-farm.ts BASEPORT DEVICES PORTS
 */
import { startSnmpAgent, type SimDevice } from '../simulators/snmp-agent';

const [base, n, p] = process.argv.slice(2).map(Number) as [number, number, number];
const agents: Awaited<ReturnType<typeof startSnmpAgent>>[] = [];
process.on('disconnect', () => process.exit(0));
(async () => {
  for (let d = 0; d < n; d++) {
    const sim: SimDevice = {
      sysName: `load-${d}`,
      sysDescr: 'Load test switch',
      ifaces: Array.from({ length: p }, (_, i) => ({ ifIndex: i + 1, name: `ether${i + 1}`, type: 6, mtu: 1500, speedMbps: 10000, mac: `02:00:00:${(d >> 8).toString(16).padStart(2, '0')}:${(d & 255).toString(16).padStart(2, '0')}:${(i + 1).toString(16).padStart(2, '0')}`, admin: 1 as const, oper: 1 as const })),
      ipv4: [],
      lldp: [],
      bgp: [],
    };
    agents.push(await startSnmpAgent(base + d, sim, { community: 'load-community', counters: 'hc' }));
  }
  const t0 = Date.now();
  // Counters move every 5 s (enough for rates; cheaper for the simulator than every second).
  setInterval(() => {
    const s = BigInt(Math.floor((Date.now() - t0) / 1000));
    agents.forEach((a, d) => {
      a.setUptime(Number(s) * 100 + 100);
      for (let i = 1; i <= p; i++) {
        a.setCounter(i, 'inOctets', s * BigInt(1_000_000 + d * 1000 + i));
        a.setCounter(i, 'outOctets', s * BigInt(500_000 + i));
        a.setCounter(i, 'inPkts', s * 1000n);
        a.setCounter(i, 'outPkts', s * 800n);
      }
    });
  }, 5000);
  process.send?.('ready');
})().catch((e) => {
  console.error(`SNMP farm: ${(e as Error).message}`);
  process.exit(1);
});
