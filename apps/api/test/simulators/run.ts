/**
 * Starts the device simulators for manual testing of discovery:
 *   npx tsx apps/api/test/simulators/run.ts
 * SNMP agent: udp 127.0.0.1:16161, community "demo-public-ro".
 * RouterOS REST mock: http on a random port, user "dcim-ro", password "demo-pass".
 * These are simulators, not real devices.
 */
import { startSnmpAgent } from './snmp-agent';
import { startRouterOs } from './http-devices';

void (async () => {
  await startSnmpAgent(16161, undefined, { community: 'demo-public-ro' });
  const ros = await startRouterOs('dcim-ro', 'demo-pass');
  process.stdout.write(`SNMP simulator on udp/127.0.0.1:16161 (community demo-public-ro)\nRouterOS REST mock on http://127.0.0.1:${ros.port} (dcim-ro / demo-pass, use scheme HTTP)\nCtrl+C to stop.\n`);
})();
