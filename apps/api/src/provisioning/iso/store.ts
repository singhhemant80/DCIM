import { spawn } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * Where an uploaded ISO and the files prepared from it live:
 *   <CDCIM_IMAGE_DIR>/<image id>/image.iso   the upload
 *   <CDCIM_IMAGE_DIR>/<image id>/boot/       kernel and initrd
 *   <CDCIM_IMAGE_DIR>/<image id>/tree/       the extracted ISO (RHEL family, ESXi)
 */
export function imagePaths(base: string, imageId: string) {
  if (!/^[0-9a-f-]{36}$/.test(imageId)) throw new Error('Bad image id');
  const dir = resolve(base, imageId);
  return { dir, iso: join(dir, 'image.iso'), boot: join(dir, 'boot'), tree: join(dir, 'tree'), kernel: join(dir, 'boot', 'kernel'), initrd: join(dir, 'boot', 'initrd') };
}

/** Free bytes on the file system holding `dir` (created if missing). */
export async function freeBytes(dir: string): Promise<number> {
  await fs.mkdir(dir, { recursive: true });
  const s = await fs.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * Index of a directory tree by lower-case relative path, so a request for
 * "efi/boot/bootx64.efi" finds "EFI/BOOT/BOOTX64.EFI" (ISO9660 names are
 * often upper case while boot loaders ask in lower case). Cached per tree.
 */
const indexes = new Map<string, { at: number; map: Map<string, string> }>();
export async function treeIndex(root: string): Promise<Map<string, string>> {
  const hit = indexes.get(root);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.map;
  const map = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) map.set(relative(root, full).split(sep).join('/').toLowerCase(), full);
    }
  };
  try {
    await walk(root);
  } catch {
    /* missing tree: empty index */
  }
  if (indexes.size > 64) indexes.clear();
  indexes.set(root, { at: Date.now(), map });
  return map;
}
export function forgetTreeIndex(root: string) {
  indexes.delete(root);
}

/** A file inside `root` for a request path; null for anything outside it or missing. */
export async function resolveInTree(root: string, path: string): Promise<string | null> {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((s) => s === '..' || s === '.' || s === '')) return null;
  const hit = (await treeIndex(root)).get(clean.toLowerCase());
  return hit && resolve(hit).startsWith(resolve(root) + sep) ? hit : null;
}

/** Volume label from the ISO9660 primary volume descriptor (sector 16, bytes 40–71). */
export async function isoVolumeId(iso: string): Promise<string | null> {
  const fh = await fs.open(iso, 'r');
  try {
    const buf = Buffer.alloc(2048);
    const { bytesRead } = await fh.read(buf, 0, 2048, 16 * 2048);
    if (bytesRead < 72 || buf.toString('latin1', 1, 6) !== 'CD001') return null;
    return buf.toString('latin1', 40, 72).replace(/\0/g, '').trim() || null;
  } finally {
    await fh.close();
  }
}

/** SHA-256 of a file, calling `progress` every ~256 MiB. */
export async function sha256File(path: string, progress?: (bytes: number) => Promise<void> | void): Promise<string> {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  let n = 0;
  let next = 256 * 1024 ** 2;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 ** 2 })) {
    h.update(chunk as Buffer);
    n += (chunk as Buffer).length;
    if (progress && n >= next) {
      next += 256 * 1024 ** 2;
      await progress(n);
    }
  }
  return h.digest('hex');
}

/* -------------------------------------------------------------- bsdtar */

function run(cmd: string, args: string[], opts: { timeoutMs: number; maxOut?: number }): Promise<{ out: Buffer; err: string }> {
  return new Promise((resolveP, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs);
    p.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (opts.maxOut && size > opts.maxOut) return p.kill('SIGKILL');
      out.push(c);
    });
    p.stderr.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-2000)));
    p.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`${cmd} is not installed (Ubuntu package libarchive-tools); re-run the NexoraDC installer`) : e);
    });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error(`${cmd} stopped (${signal === 'SIGKILL' ? 'took too long or produced too much output' : signal})`));
      if (code !== 0) return reject(new Error(`${cmd} failed: ${err.trim().split('\n').slice(-2).join(' ') || `exit ${code}`}`));
      resolveP({ out: Buffer.concat(out), err });
    });
  });
}

const BSDTAR = process.env.CDCIM_BSDTAR ?? 'bsdtar';

/** Paths inside the ISO (files and directories). */
export async function listIso(iso: string): Promise<string[]> {
  const { out } = await run(BSDTAR, ['-tf', iso], { timeoutMs: 5 * 60_000, maxOut: 64 * 1024 ** 2 });
  return out
    .toString('utf8')
    .split('\n')
    .map((s) => s.replace(/^\.?\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean);
}

/** One small file from the ISO as text (null when missing or larger than `max`). */
export async function readIsoFile(iso: string, path: string, max = 256 * 1024): Promise<string | null> {
  try {
    const { out } = await run(BSDTAR, ['-xOf', iso, path], { timeoutMs: 60_000, maxOut: max });
    return out.toString('utf8');
  } catch {
    return null;
  }
}

/** Extracts the ISO (or only `paths`) into `dest`. Files are made readable by the owner and group only. */
export async function extractIso(iso: string, dest: string, paths?: string[]): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  // --no-same-owner/permissions: ISO modes are read-only; files must stay manageable (deletable) by NexoraDC.
  await run(BSDTAR, ['-xf', iso, '-C', dest, '--no-same-owner', '--no-same-permissions', '--no-xattrs', ...(paths ?? [])], { timeoutMs: 60 * 60_000 });
  // Directories from a read-only ISO would block deleting the image later.
  await run('chmod', ['-R', 'u+rwX', dest], { timeoutMs: 10 * 60_000 });
}
