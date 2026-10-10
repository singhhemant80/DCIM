import { createHash, randomBytes } from 'node:crypto';

/** SecretBox AAD strings: a ciphertext only decrypts for the row it was written for. */
export const controlContext = (orgId: string, deviceId: string, kind: string, host: string, port: number | null) => `control_credential:${orgId}:${deviceId}:${kind}:${host.toLowerCase()}:${port ?? ''}`;
export const jobContext = (orgId: string, jobId: string) => `provisioning_job:${orgId}:${jobId}`;
export const virtContext = (orgId: string, id: string, kind: string, url: string) => `virt_integration:${orgId}:${id}:${kind}:${url}`;

/** Boot tokens are handed to the installer in URLs; only their hash is stored. */
export const newBootToken = () => randomBytes(24).toString('base64url');
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export const GUEST_TARGET_STATUS = { start: 'running', resume: 'running', reboot: 'running', stop: 'stopped', shutdown: 'stopped', suspend: 'suspended' } as const;
