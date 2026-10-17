import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_TEMPLATES, type DetectedIso } from '@crapplet/shared';
import { osImages, type OsImage } from '../../db/schema';
import { detectIso, type Detection } from '../../provisioning/iso/detect';
import { extractIso, forgetTreeIndex, freeBytes, imagePaths, isoVolumeId, listIso, readIsoFile, sha256File } from '../../provisioning/iso/store';
import { PermanentError, type KindDef, type StepContext } from './engine';

/**
 * Prepares an uploaded ISO for installs: checks its size and SHA-256, looks
 * inside to find the OS and how it boots, and extracts the kernel and initrd
 * (or the whole tree, for installers that read their packages over HTTP).
 * Debian network installs use the matching netboot installer from the Debian
 * mirror, checked against the mirror's SHA256SUMS. Nothing here talks to a
 * server or BMC.
 */

const D = (ctx: StepContext) => ctx.deps as unknown as { db: import('../../db/db').Db; imageDir: string; fetchImpl?: typeof fetch };

async function imageOf(ctx: StepContext): Promise<OsImage> {
  if (!ctx.job.imageId) throw new PermanentError('The image was deleted');
  const [img] = await D(ctx).db.select().from(osImages).where(eq(osImages.id, ctx.job.imageId));
  if (!img) throw new PermanentError('The image was deleted');
  return img;
}

const MIB = 1024 ** 2;
const fmt = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : `${(n / MIB).toFixed(1)} MiB`);

/** Downloads a file over HTTPS to `dest` and returns its SHA-256 (size-capped, with a stall timeout). */
async function download(ctx: StepContext, url: string, dest: string, max = 512 * MIB): Promise<string> {
  const f = D(ctx).fetchImpl ?? fetch;
  const ctrl = new AbortController();
  let stall = setTimeout(() => ctrl.abort(new Error(`No data from ${url} for 60 s`)), 60_000);
  try {
    const res = await f(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${url}`);
    const h = createHash('sha256');
    let n = 0;
    const src = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    src.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) src.destroy(new Error(`${url} is larger than expected`));
      h.update(c);
      clearTimeout(stall);
      stall = setTimeout(() => ctrl.abort(new Error(`No data from ${url} for 60 s`)), 60_000);
    });
    await pipeline(src, createWriteStream(dest));
    return h.digest('hex');
  } finally {
    clearTimeout(stall);
  }
}

async function fetchText(ctx: StepContext, url: string): Promise<string> {
  const f = D(ctx).fetchImpl ?? fetch;
  const res = await f(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.text()).slice(0, 1024 * 1024);
}

/** Debian netboot kernel + initrd for a release, checked against the mirror's SHA256SUMS. */
async function debianNetboot(ctx: StepContext, codename: string, arch: string, kernel: string, initrd: string) {
  const mirrors = ['https://deb.debian.org/debian', 'https://archive.debian.org/debian'];
  const errors: string[] = [];
  for (const m of mirrors) {
    const base = `${m}/dists/${codename}/main/installer-${arch}/current/images`;
    try {
      const sums = await fetchText(ctx, `${base}/SHA256SUMS`);
      const want = (rel: string) => new RegExp(`^([0-9a-f]{64})\\s+\\.?/?${rel.replace(/[.]/g, '\\.')}$`, 'm').exec(sums)?.[1];
      const kRel = `netboot/debian-installer/${arch}/linux`;
      const iRel = `netboot/debian-installer/${arch}/initrd.gz`;
      const kWant = want(kRel);
      const iWant = want(iRel);
      if (!kWant || !iWant) throw new Error('the netboot files are not listed in SHA256SUMS');
      const kGot = await download(ctx, `${base}/${kRel}`, kernel);
      await ctx.heartbeat();
      const iGot = await download(ctx, `${base}/${iRel}`, initrd);
      if (kGot !== kWant || iGot !== iWant) throw new PermanentError('The Debian netboot files do not match the mirror’s SHA256SUMS');
      return `${base}/netboot/debian-installer/${arch}/`;
    } catch (e) {
      if (e instanceof PermanentError) throw e;
      errors.push(`${m}: ${(e as Error).message}`);
    }
  }
  throw new Error(`Could not download the Debian ${codename} netboot installer (${errors.join('; ')}). The NexoraDC server needs internet access to deb.debian.org for Debian network installs.`);
}

export const imageProcessKind: KindDef = {
  steps: () => [
    {
      name: 'Check the upload',
      safeToRepeat: true,
      run: async (ctx) => {
        const img = await imageOf(ctx);
        const p = imagePaths(D(ctx).imageDir, img.id);
        const st = await fs.stat(p.iso).catch(() => null);
        if (!st) throw new PermanentError('The uploaded file is missing; upload the ISO again');
        if (img.uploadSize !== null && st.size !== img.uploadSize) throw new PermanentError(`The upload is incomplete (${fmt(st.size)} of ${fmt(img.uploadSize)})`);
        return { done: true, detail: `${img.uploadFileName ?? 'ISO'}, ${fmt(st.size)}` };
      },
    },
    {
      name: 'Compute the SHA-256',
      safeToRepeat: true,
      maxAttempts: 2,
      run: async (ctx) => {
        const img = await imageOf(ctx);
        const sha = await sha256File(imagePaths(D(ctx).imageDir, img.id).iso, () => ctx.heartbeat());
        ctx.state.sha256 = sha;
        if (img.expectedSha256 && img.expectedSha256 !== sha) throw new PermanentError(`The ISO does not match the SHA-256 you entered (got ${sha}); the file may be damaged or a different release`);
        return { done: true, detail: `${sha}${img.expectedSha256 ? ' (matches)' : ''}` };
      },
    },
    {
      name: 'Look inside the ISO',
      safeToRepeat: true,
      run: async (ctx) => {
        const img = await imageOf(ctx);
        const iso = imagePaths(D(ctx).imageDir, img.id).iso;
        let paths: string[];
        try {
          paths = await listIso(iso);
        } catch (e) {
          throw new PermanentError(`The file could not be read as an ISO: ${(e as Error).message}`);
        }
        const det = await detectIso({ paths, volumeId: await isoVolumeId(iso).catch(() => null), read: (path) => readIsoFile(iso, path) });
        ctx.state.detection = det;
        return { done: true, detail: `${det.label ?? 'ISO'}: ${det.bootKind}${det.methods.includes('pxe') ? ', network boot possible' : ', virtual media only'}` };
      },
    },
    {
      name: 'Prepare the boot files',
      safeToRepeat: true,
      maxAttempts: 3,
      run: async (ctx) => {
        const img = await imageOf(ctx);
        const det = ctx.state.detection as Detection;
        const p = imagePaths(D(ctx).imageDir, img.id);
        await fs.rm(p.boot, { recursive: true, force: true });
        await fs.rm(p.tree, { recursive: true, force: true });
        forgetTreeIndex(p.tree);
        await fs.mkdir(p.boot, { recursive: true });
        const notes: string[] = [];
        if (det.extract.tree) {
          const isoSize = (await fs.stat(p.iso)).size;
          const free = await freeBytes(p.dir);
          if (free < isoSize * 1.05) throw new PermanentError(`Not enough disk space to extract the ISO (${fmt(isoSize)} needed, ${fmt(free)} free in ${D(ctx).imageDir})`);
          await extractIso(p.iso, p.tree);
          notes.push(`ISO extracted (${fmt(isoSize)})`);
        }
        if (det.extract.kernel && det.extract.initrd) {
          if (det.extract.tree) {
            await fs.copyFile(`${p.tree}/${det.extract.kernel}`, p.kernel);
            await fs.copyFile(`${p.tree}/${det.extract.initrd}`, p.initrd);
          } else {
            const tmp = `${p.boot}/x`;
            await extractIso(p.iso, tmp, [det.extract.kernel, det.extract.initrd]);
            await fs.rename(`${tmp}/${det.extract.kernel}`, p.kernel);
            await fs.rename(`${tmp}/${det.extract.initrd}`, p.initrd);
            await fs.rm(tmp, { recursive: true, force: true });
          }
          notes.push('kernel and initrd extracted');
        }
        if (det.bootKind === 'debian' && det.methods.includes('pxe')) {
          const arch = det.arch === 'arm64' ? 'arm64' : 'amd64';
          const src = await debianNetboot(ctx, det.codename!, arch, p.kernel, p.initrd);
          ctx.state.netbootSource = src;
          notes.push(`netboot installer from ${src}`);
        }
        return { done: true, detail: notes.join('; ') || 'Nothing to extract (virtual media only)' };
      },
    },
    {
      name: 'Mark the image ready',
      safeToRepeat: true,
      run: async (ctx) => {
        const img = await imageOf(ctx);
        const det = ctx.state.detection as Detection;
        const { extract: _x, ...detected } = det;
        const d: DetectedIso & { netbootSource?: string } = { ...detected, ...(ctx.state.netbootSource ? { netbootSource: String(ctx.state.netbootSource) } : {}) };
        const tpl = DEFAULT_TEMPLATES[det.bootKind];
        const family = (['rhel', 'debian', 'ubuntu', 'proxmox', 'esxi', 'windows'] as const).includes(det.bootKind as never) ? det.bootKind : 'other';
        await D(ctx)
          .db.update(osImages)
          .set({
            uploadStatus: 'ready',
            processError: null,
            bootKind: det.bootKind,
            detected: d as unknown as Record<string, unknown>,
            family,
            version: img.version ?? det.version,
            arch: det.arch === 'arm64' || det.arch === 'aarch64' ? 'aarch64' : 'x86_64',
            isoSha256: String(ctx.state.sha256),
            verifyStatus: 'verified',
            verifiedAt: ctx.now(),
            verifyError: null,
            sizes: { ISO: img.uploadSize ?? 0 },
            // A template the operator already set is kept.
            ...(img.templateKind === 'none' && tpl ? { templateKind: tpl.kind, template: tpl.template } : {}),
          })
          .where(sql`${osImages.id} = ${img.id} and ${osImages.uploadStatus} = 'processing'`);
        return { done: true, detail: det.label ?? det.bootKind };
      },
    },
  ],
  async cleanup(ctx) {
    if (ctx.job.imageId)
      await D(ctx)
        .db.update(osImages)
        .set({ uploadStatus: 'failed', processError: (ctx.job.error ?? 'Preparation did not finish').slice(0, 1000), verifyStatus: 'error' })
        .where(sql`${osImages.id} = ${ctx.job.imageId} and ${osImages.uploadStatus} = 'processing'`);
  },
};
