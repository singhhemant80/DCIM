import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A piece of a served file: bytes in memory or a range of a file on disk. */
export type Segment = { data: Buffer } | { file: string; size: number };

const segSize = (s: Segment) => ('data' in s ? s.data.length : s.size);

/**
 * Sends the concatenation of `segments`, honouring a single HTTP Range (BMC
 * virtual media and some installers read ISOs in ranges) and HEAD requests.
 */
export async function serveSegments(req: IncomingMessage, res: ServerResponse, segments: Segment[], contentType: string): Promise<void> {
  const total = segments.reduce((a, s) => a + segSize(s), 0);
  let start = 0;
  let end = total - 1;
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (!m[1] && !m[2])) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${total}`);
      res.end();
      return;
    }
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    } else {
      start = Math.max(0, total - Number(m[2]));
    }
    if (start > end || start >= total) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${total}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  } else res.statusCode = 200;
  res.setHeader('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  let pos = 0;
  for (const s of segments) {
    const size = segSize(s);
    const segStart = pos;
    const segEnd = pos + size - 1;
    pos += size;
    if (segEnd < start || segStart > end || size === 0) continue;
    const from = Math.max(start, segStart) - segStart;
    const to = Math.min(end, segEnd) - segStart;
    if ('data' in s) {
      if (!res.write(s.data.subarray(from, to + 1))) await new Promise((r) => res.once('drain', r));
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      const rs = createReadStream(s.file, { start: from, end: to, highWaterMark: 1024 * 1024 });
      rs.on('error', reject);
      rs.on('end', resolve);
      res.on('close', () => rs.destroy());
      rs.pipe(res, { end: false });
    });
    if (res.destroyed) return;
  }
  res.end();
}
