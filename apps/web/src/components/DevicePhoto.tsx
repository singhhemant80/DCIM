import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Button, ErrorNote, Panel } from './ui';

export const photoUrl = (deviceId: string, version: string | null | undefined) => `/api/v1/dcim/devices/${deviceId}/photo?v=${encodeURIComponent(version ?? '')}`;

/**
 * Shrinks a camera photo in the browser before upload: at most 2000 px on the
 * long side, JPEG, and under ~900 KB (the server accepts up to 1 MB).
 */
export async function shrinkPhoto(file: File): Promise<string> {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) throw new Error('Choose a JPEG, PNG or WebP photo');
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This image could not be read; save it as JPEG or PNG and try again');
  });
  let max = 2000;
  for (let attempt = 0; attempt < 6; attempt++) {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const quality = attempt < 2 ? 0.86 - attempt * 0.08 : 0.72;
    const url = canvas.toDataURL('image/jpeg', quality);
    if ((url.length * 3) / 4 < 900_000) return url;
    if (attempt >= 1) max = Math.round(max * 0.75);
  }
  throw new Error('The photo is too large even after shrinking it');
}

/** Front-panel photo: shown on the device page, uploaded and replaced by staff. */
export function DevicePhotoPanel({ deviceId, photoUpdatedAt, canWrite }: { deviceId: string; photoUpdatedAt: string | null | undefined; canWrite: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['dcim', 'device', deviceId] });
  const remove = useMutation({ mutationFn: () => api.delete(`/dcim/devices/${deviceId}/photo`), onSuccess: refresh });
  if (!photoUpdatedAt && !canWrite) return null;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const image = await shrinkPhoto(file);
      await api.put(`/dcim/devices/${deviceId}/photo`, { image });
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <Panel
      title="Front photo"
      actions={
        canWrite && (
          <span className="flex gap-2">
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/*" capture="environment" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
            <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? 'Uploading…' : photoUpdatedAt ? 'Replace' : 'Upload photo'}
            </Button>
            {photoUpdatedAt && (
              <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Remove
              </Button>
            )}
          </span>
        )
      }
    >
      {photoUpdatedAt ? (
        <a href={photoUrl(deviceId, photoUpdatedAt)} target="_blank" rel="noreferrer" title="Open full size">
          <img src={photoUrl(deviceId, photoUpdatedAt)} alt="Front of the device" className="max-h-72 w-full rounded-lg bg-sunken object-contain" />
        </a>
      ) : (
        <p className="text-[13px] text-ink-2">No photo yet. Upload a picture of the front panel (from a phone, the camera opens directly); it is shown here and printed on the datasheet.</p>
      )}
      {photoUpdatedAt && <p className="mt-2 text-[12px] text-ink-3">Updated {formatDateTime(photoUpdatedAt)}</p>}
      {error != null && <ErrorNote error={error} />}
      {remove.error && <ErrorNote error={remove.error} />}
    </Panel>
  );
}
