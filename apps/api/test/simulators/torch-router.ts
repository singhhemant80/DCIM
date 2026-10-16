/**
 * Development stand-in for a MikroTik answering the RouterOS API with a Torch
 * stream that changes every second. Run: npx tsx test/simulators/torch-router.ts [port]
 */
import { startRouterOsApi } from './routeros-api';

const port = Number(process.argv[2] ?? 18728);
const addrs = ['103.150.120.2', '103.150.120.3', '103.150.120.4', '103.150.121.2', '103.150.121.3', '103.150.121.5', '103.150.121.9'];
const remote = ['142.250.183.14', '104.16.132.229', '151.101.1.69', '13.107.42.14'];
let t = 0;
const rows = () => {
  t++;
  return addrs.map((a, i) => {
    // Each address swings at its own pace, so the ranking moves second by second.
    const wave = 0.6 + 0.4 * Math.sin(t / (3 + i) + i);
    return { 'src-address': remote[i % remote.length], 'dst-address': a, rx: Math.round((220e6 / (i + 1)) * wave * (0.9 + Math.random() * 0.2)), tx: Math.round((45e6 / (i + 1.5)) * (1.4 - wave) * (0.9 + Math.random() * 0.2)) };
  });
};
void startRouterOsApi('dcim-ro', 'api-pass-123', undefined, { torch: { rows, everyMs: 1000 }, port }).then((sim) => process.stdout.write(`torch router: RouterOS API on 127.0.0.1:${sim.port} (dcim-ro / api-pass-123)\n`));
