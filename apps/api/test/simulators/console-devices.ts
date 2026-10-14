import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { vncAuthResponse } from '../../src/worker/console/des';

/**
 * A VNC server shaped like a BMC's (RFB 3.8, VNC authentication). After
 * ServerInit it answers any bytes with "ECHO:" + the bytes, so tests can see
 * traffic pass through. A simulator, not a capture from a real iDRAC.
 */
export async function startVncServer(password: string): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
  let connections = 0;
  const socks = new Set<net.Socket>();
  const server = net.createServer((s) => {
    connections++;
    socks.add(s);
    s.on('close', () => socks.delete(s));
    let stage = 0;
    let buf = Buffer.alloc(0);
    const challenge = randomBytes(16);
    s.write('RFB 003.008\n');
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 0 && buf.length >= 12) {
          buf = buf.subarray(12);
          s.write(Buffer.from([1, 2]));
          stage = 1;
        } else if (stage === 1 && buf.length >= 1) {
          buf = buf.subarray(1);
          s.write(challenge);
          stage = 2;
        } else if (stage === 2 && buf.length >= 16) {
          const ok = buf.subarray(0, 16).equals(vncAuthResponse(password, challenge));
          buf = buf.subarray(16);
          if (!ok) {
            const why = Buffer.from('Authentication failed');
            const h = Buffer.alloc(8);
            h.writeUInt32BE(1, 0);
            h.writeUInt32BE(why.length, 4);
            s.end(Buffer.concat([h, why]));
            return;
          }
          s.write(Buffer.from([0, 0, 0, 0]));
          stage = 3;
        } else if (stage === 3 && buf.length >= 1) {
          buf = buf.subarray(1);
          const name = Buffer.from('iDRAC Virtual Console');
          const init = Buffer.alloc(24);
          init.writeUInt16BE(1024, 0);
          init.writeUInt16BE(768, 2);
          init.writeUInt32BE(name.length, 20);
          s.write(Buffer.concat([init, name]));
          stage = 4;
        } else if (stage === 4 && buf.length) {
          s.write(Buffer.concat([Buffer.from('ECHO:'), buf]));
          buf = Buffer.alloc(0);
        } else break;
      }
    });
    s.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    connections: () => connections,
    close: () =>
      new Promise((r) => {
        for (const s of socks) s.destroy();
        server.close(() => r());
      }),
  };
}

/** A stand-in ipmitool for Serial-over-LAN: checks IPMI_PASSWORD, echoes input in capitals. */
export function fakeSolIpmitool(password: string): { path: string; argsFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cdcim-sol-'));
  const argsFile = join(dir, 'args.log');
  const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args) + '\\n');
if (process.env.IPMI_PASSWORD !== ${JSON.stringify(password)}) { process.stderr.write('Error: Unable to establish IPMI v2 / RMCP+ session\\n'); process.exit(1); }
if (args.slice(-2).join(' ') === 'sol deactivate') process.exit(0);
if (args.slice(-2).join(' ') !== 'sol activate') { process.stderr.write('Invalid command\\n'); process.exit(1); }
process.stdout.write('[SOL Session operational.  Use ~? for help]\\r\\n');
process.stdin.on('data', (d) => process.stdout.write(d.toString().toUpperCase()));
process.stdin.on('end', () => process.exit(0));
`;
  const path = join(dir, 'ipmitool');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { path, argsFile };
}
