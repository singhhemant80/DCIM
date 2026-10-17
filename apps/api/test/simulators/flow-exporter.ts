/**
 * Development stand-in for a MikroTik router exporting Traffic Flow (IPFIX) to
 * the worker's collector: every 5 seconds it reports flows for a few addresses
 * with steady, different rates. Run: npx tsx test/simulators/flow-exporter.ts [port] [addresses…]
 */
import { createSocket } from 'node:dgram';
import { encodeTemplated, type SimFlow } from '../../src/worker/flows/encode';

const port = Number(process.argv[2] ?? 2055);
const addrs = process.argv.slice(3).length ? process.argv.slice(3) : ['103.150.120.2', '103.150.120.3', '103.150.120.4', '103.150.121.2', '103.150.121.3', '103.150.121.5', '103.150.121.9'];
// Mbit/s down and up per address (each a little different).
const rates = addrs.map((_, i) => ({ down: 180 / (i + 1) + 3, up: 40 / (i + 1.5) + 1 }));
const sock = createSocket('udp4');
const boot = Date.now() - 3_600_000;
let seq = 0;
let n = 0;
// The first addresses are in MaxMind's test databases (test/fixtures/geoip), so ASN and location show in development.
const remote = ['81.2.69.142', '1.128.0.1', '89.160.20.112', '216.160.83.56', '2.125.160.216', '142.250.183.14', '104.16.132.229'];

function tick() {
  const now = Date.now();
  const flows: SimFlow[] = [];
  addrs.forEach((a, i) => {
    const jitter = 0.75 + Math.random() * 0.5;
    const r = remote[(i + n) % remote.length]!;
    flows.push({ src: r, dst: a, bytes: Math.round(((rates[i]!.down * 1e6) / 8) * 5 * jitter), packets: 4000, start: now - 5000, end: now });
    flows.push({ src: a, dst: r, bytes: Math.round(((rates[i]!.up * 1e6) / 8) * 5 * jitter), packets: 1500, start: now - 5000, end: now });
  });
  // Transit between two internet addresses: counted as "not your addresses".
  flows.push({ src: '8.8.8.8', dst: '1.1.1.1', bytes: 5000, packets: 4, start: now - 5000, end: now });
  const pkt = encodeTemplated(10, flows, { sysUptimeMs: now - boot, nowMs: now, sequence: seq++, withTemplate: n % 6 === 0 });
  sock.send(pkt, port, '127.0.0.1');
  n++;
}
tick();
setInterval(tick, 5000);
process.stdout.write(`flow exporter: IPFIX to 127.0.0.1:${port} for ${addrs.length} addresses every 5 s\n`);
