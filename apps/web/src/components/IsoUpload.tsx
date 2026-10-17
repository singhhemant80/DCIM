import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MAX_ISO_BYTES, UPLOAD_CHUNK_BYTES } from '@crapplet/shared';
import { api, readCookie } from '../lib/api';
import { bytes, newIdempotencyKey, type OsImageT } from '../lib/provisioning';
import { Button, ErrorNote, Field, Input, Modal, cx } from './ui';

/**
 * ISO upload: the file goes to the server in 8 MiB chunks. A lost response or
 * a network error resumes from the server's own offset; an upload interrupted
 * by closing the page can be resumed by choosing the same file again. When all
 * bytes are in, the server checks the SHA-256 and works out how the ISO boots.
 */

async function sendChunks(img: { id: string; uploadedBytes: number }, file: File, onProgress: (n: number) => void, signal: AbortSignal): Promise<void> {
  let off = img.uploadedBytes;
  let failures = 0;
  while (off < file.size) {
    if (signal.aborted) throw new Error('Upload paused');
    const chunk = file.slice(off, off + UPLOAD_CHUNK_BYTES);
    let res: Response;
    try {
      res = await fetch(`/api/v1/provisioning/images/${img.id}/upload`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(off), 'X-CSRF-Token': readCookie('cdcim_csrf') ?? '' },
        body: chunk,
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw new Error('Upload paused');
      if (++failures > 6) throw new Error(`The connection keeps failing (${(e as Error).message}); press Resume to try again`);
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)));
      continue;
    }
    if (res.status === 409) {
      // The server already has more (or less) than we thought: continue from its offset.
      const b = (await res.json().catch(() => ({}))) as { uploadedBytes?: number; message?: string };
      if (typeof b.uploadedBytes === 'number') {
        off = b.uploadedBytes;
        onProgress(off);
        continue;
      }
      throw new Error(b.message ?? 'The upload was refused');
    }
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { message?: string };
      if (res.status >= 500 && ++failures <= 6) {
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)));
        continue;
      }
      throw new Error(b.message ?? `HTTP ${res.status}`);
    }
    failures = 0;
    off += chunk.size;
    onProgress(off);
  }
}

export function IsoUploadDialog({ open, onClose, resume }: { open: boolean; onClose: () => void; resume?: OsImageT | null }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(resume?.name ?? '');
  const [sha, setSha] = useState('');
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; started: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const pick = (f: File | undefined | null) => {
    if (!f) return;
    setError(null);
    if (!/\.iso$/i.test(f.name)) return setError(new Error('Choose an .iso file'));
    if (f.size > MAX_ISO_BYTES) return setError(new Error('The file is larger than 64 GiB'));
    if (resume && (f.size !== resume.uploadSize || f.name !== resume.uploadFileName)) return setError(new Error(`Choose the same file as before: ${resume.uploadFileName} (${bytes(resume.uploadSize ?? 0)})`));
    setFile(f);
    if (!name)
      setName(
        f.name
          .replace(/\.iso$/i, '')
          .replace(/[-_]+/g, ' ')
          .slice(0, 120),
      );
  };

  const start = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    const c = new AbortController();
    ctrl.current = c;
    try {
      const img = resume ?? (await api.post<OsImageT>('/provisioning/images/upload', { name: name.trim(), fileName: file.name, size: file.size, expectedSha256: sha.trim().toLowerCase() || null }));
      const fresh = resume ? await api.get<OsImageT[]>('/provisioning/images').then((l) => l.find((i) => i.id === resume.id) ?? resume) : img;
      setProgress({ done: fresh.uploadedBytes, total: file.size, started: Date.now() });
      void qc.invalidateQueries({ queryKey: ['provisioning', 'images'] });
      await sendChunks(fresh, file, (n) => setProgress((p) => (p ? { ...p, done: n } : p)), c.signal);
      await api.post(`/provisioning/images/${fresh.id}/upload/complete`, {}, { 'Idempotency-Key': newIdempotencyKey() });
      void qc.invalidateQueries({ queryKey: ['provisioning'] });
      onClose();
    } catch (e) {
      setError(e);
      void qc.invalidateQueries({ queryKey: ['provisioning', 'images'] });
    } finally {
      setBusy(false);
    }
  };

  const pct = progress ? Math.floor((progress.done / progress.total) * 100) : 0;
  const rate = progress && Date.now() > progress.started + 2000 ? progress.done / ((Date.now() - progress.started) / 1000) : null;
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          ctrl.current?.abort();
          onClose();
        }
      }}
      title={resume ? `Resume uploading ${resume.name}` : 'Upload an ISO'}
      description="Any installer ISO: Ubuntu, Debian, Rocky / Alma / CentOS / RHEL / Fedora, Proxmox VE, VMware ESXi or Windows. NexoraDC checks its SHA-256, finds out how it boots and prepares it for network install (PXE) or virtual media."
      wide
    >
      <div className="flex flex-col gap-3">
        <div
          role="button"
          tabIndex={0}
          onClick={() => !busy && input.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !busy && input.current?.click()}
          onDragOver={(e) => (e.preventDefault(), setDrag(true))}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (!busy) pick(e.dataTransfer.files[0]);
          }}
          className={cx(
            'flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-5 text-center text-[13px]',
            drag ? 'border-accent bg-accent-soft' : 'border-rule bg-sunken/50 hover:border-accent/60',
          )}
        >
          {file ? (
            <>
              <span className="font-medium break-all">{file.name}</span>
              <span className="text-ink-3">{bytes(file.size)}</span>
            </>
          ) : (
            <>
              <span className="font-medium">Drop the ISO here, or click to choose it</span>
              <span className="text-ink-3">{resume ? `The same file as before: ${resume.uploadFileName}` : 'Up to 64 GiB'}</span>
            </>
          )}
          <input ref={input} type="file" accept=".iso,application/x-iso9660-image" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
        </div>
        {!resume && (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ubuntu 24.04 LTS" required disabled={busy} />}</Field>
            <Field label="SHA-256 (optional)" hint="From the vendor’s download page; the upload is rejected if it differs.">
              {(id) => <Input id={id} className="font-mono text-[12px]" value={sha} onChange={(e) => setSha(e.target.value)} disabled={busy} />}
            </Field>
          </div>
        )}
        {progress && (
          <div>
            <div className="h-2 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1 text-[12.5px] text-ink-3">
              {bytes(progress.done)} of {bytes(progress.total)} ({pct}%){rate ? ` · ${bytes(rate)}/s` : ''}. Keep this window open; if it closes, choose the same file again to resume.
            </p>
          </div>
        )}
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          {busy ? (
            <Button type="button" variant="ghost" onClick={() => ctrl.current?.abort()}>
              Pause
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={onClose}>
              Close
            </Button>
          )}
          <Button type="button" variant="primary" busy={busy} disabled={!file || (!resume && !name.trim())} onClick={() => void start()}>
            {progress && !busy ? 'Resume' : 'Upload'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
