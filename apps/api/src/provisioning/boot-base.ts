import { BlockList, isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/db';
import { pxeSettings } from '../db/schema';

/**
 * The base URL servers being installed use to reach NexoraDC (iPXE script,
 * install files, configuration, callback): the PXE settings' boot URL, else
 * CDCIM_PUBLIC_URL, else http://<PXE server address>. Plain HTTP is normal
 * here: iPXE and most installers cannot check a certificate, and every boot
 * URL carries the job's one-time token and only works while the job runs.
 */
export async function bootBaseUrl(db: Db, orgId: string, publicUrl: string | undefined | null): Promise<string | null> {
  const [s] = await db.select({ bootBaseUrl: pxeSettings.bootBaseUrl, serverAddress: pxeSettings.serverAddress }).from(pxeSettings).where(eq(pxeSettings.orgId, orgId));
  const base = s?.bootBaseUrl || publicUrl || (s?.serverAddress ? `http://${s.serverAddress}` : null);
  // NexoraDC's iPXE build has no HTTPS: boot traffic uses http:// on the same host (nginx serves /api/v1/boot on port 80).
  return base ? base.replace(/^https:/, 'http:').replace(/\/$/, '') : null;
}

/** Bumped when PXE settings change, so cached allow-lists are rebuilt at once (same process). */
export const bootSettingsVersion = { n: 0 };

export function addCidrs(list: BlockList, cidrs: string[]) {
  for (const c of cidrs) {
    const [addr, len] = c.trim().split('/');
    const family = isIP(addr ?? '');
    if (!family) continue;
    list.addSubnet(addr!, len === undefined ? (family === 4 ? 32 : 128) : Number(len), family === 4 ? 'ipv4' : 'ipv6');
  }
}
