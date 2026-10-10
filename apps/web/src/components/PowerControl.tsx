import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { POWER_ACTIONS, POWER_ACTION_LABELS, type PowerAction } from '@crapplet/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { isActive, jobKindLabel, newIdempotencyKey, type ControlStatusT, type JobT } from '../lib/provisioning';
import { Button, ErrorNote, Field, Input, Loading, Modal, Panel, Select } from './ui';
import { JobModal, JobStatusChip } from './Jobs';

const DESTRUCTIVE: PowerAction[] = ['off', 'restart', 'power_cycle'];

/** Typed-name confirmation for one power action; the request carries an idempotency key. */
function PowerActionDialog({ deviceId, name, action, onClose, onQueued }: { deviceId: string; name: string; action: PowerAction | null; onClose: () => void; onQueued: (id: string) => void }) {
  const [confirm, setConfirm] = useState('');
  const [key] = useState(newIdempotencyKey);
  const m = useMutation({
    mutationFn: () => api.post<JobT>(`/provisioning/devices/${deviceId}/power-actions`, { action, confirm }, { 'Idempotency-Key': `${key}:${action}` }),
    onSuccess: (j) => onQueued(j.id),
  });
  if (!action) return null;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`${POWER_ACTION_LABELS[action]}: ${name}`}>
      <p className="text-ink-2">
        {DESTRUCTIVE.includes(action) ? 'This cuts power or resets the server without warning the operating system; unsaved work and open connections are lost.' : action.startsWith('graceful') ? 'The operating system is asked to shut down; if it ignores the request, the job fails rather than forcing power off.' : 'The server is switched on.'}{' '}
        The job is finished only when the BMC reports the expected power state.
      </p>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label={`Type ${name} to confirm`}>{(id) => <Input id={id} autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />}</Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={DESTRUCTIVE.includes(action) ? 'danger' : 'primary'} busy={m.isPending} disabled={confirm.trim().toLowerCase() !== name.toLowerCase()}>
            {POWER_ACTION_LABELS[action]}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** BMC control credential (staff with provisioning.execute). Write-only: the password is never shown. */
function ControlCredentialDialog({ deviceId, current, open, onClose }: { deviceId: string; current: ControlStatusT['credential']; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'redfish' | 'ipmi'>(current?.kind ?? 'redfish');
  const [host, setHost] = useState(current?.host ?? '');
  const [port, setPort] = useState(current?.port ? String(current.port) : '');
  const [username, setUsername] = useState(current?.username ?? '');
  const [password, setPassword] = useState('');
  const [scheme, setScheme] = useState<'https' | 'http'>('https');
  const [verifyTls, setVerifyTls] = useState(true);
  const save = useMutation({
    mutationFn: () => api.put(`/provisioning/devices/${deviceId}/control`, kind === 'redfish' ? { kind, host, port: port ? Number(port) : null, username, password, scheme, verifyTls } : { kind, host, port: port ? Number(port) : null, username, password }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['provisioning', 'control', deviceId] });
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/provisioning/devices/${deviceId}/control`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['provisioning', 'control', deviceId] });
      onClose();
    },
  });
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title="BMC control access" description="A BMC account allowed to change power and boot settings. It is separate from the read-only monitoring credential and is used only by provisioning jobs.">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Protocol">
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as 'redfish' | 'ipmi')}>
                <option value="redfish">Redfish (power, boot, virtual media)</option>
                <option value="ipmi">IPMI (power and PXE boot only)</option>
              </Select>
            )}
          </Field>
          <Field label="Port" hint={kind === 'ipmi' ? 'Default 623' : 'Default 443 / 80'}>
            {(id) => <Input id={id} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />}
          </Field>
        </div>
        <Field label="BMC address">{(id) => <Input id={id} value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.10.21" required />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="User name">{(id) => <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="off" />}</Field>
          <Field label="Password" hint={current ? 'Enter it again to change any setting' : undefined}>
            {(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />}
          </Field>
        </div>
        {kind === 'redfish' && (
          <div className="flex flex-wrap items-center gap-4 text-[13px]">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={scheme === 'https'} onChange={(e) => setScheme(e.target.checked ? 'https' : 'http')} /> HTTPS
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={verifyTls} disabled={scheme !== 'https'} onChange={(e) => setVerifyTls(e.target.checked)} /> Verify the TLS certificate
            </label>
          </div>
        )}
        <ErrorNote error={save.error ?? remove.error} />
        <div className="flex justify-end gap-2">
          {current && (
            <Button type="button" variant="ghost" className="mr-auto text-crit" busy={remove.isPending} onClick={() => remove.mutate()}>
              Remove
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Device page panel: power actions through the control credential, with job progress. */
export function PowerControlPanel({ deviceId }: { deviceId: string }) {
  const { can, me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const canConfigure = staff && can('provisioning.execute');
  const q = useQuery({
    queryKey: ['provisioning', 'control', deviceId],
    queryFn: () => api.get<ControlStatusT>(`/provisioning/devices/${deviceId}/control`),
    refetchInterval: (query) => (query.state.data?.activeJob ? 4000 : false),
  });
  const recent = useQuery({
    queryKey: ['provisioning', 'jobs', 'device', deviceId],
    queryFn: () => api.get<{ items: JobT[] }>(`/provisioning/jobs?deviceId=${deviceId}&pageSize=5`),
    refetchInterval: q.data?.activeJob ? 4000 : false,
  });
  const qc = useQueryClient();
  const [action, setAction] = useState<PowerAction | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [cred, setCred] = useState(false);
  if (q.isLoading) return <Panel title="Power control"><Loading /></Panel>;
  if (q.error) return <Panel title="Power control"><ErrorNote error={q.error} /></Panel>;
  const s = q.data!;
  return (
    <Panel
      title="Power control"
      actions={
        canConfigure && (
          <div className="flex gap-1">
            {s.configured && !s.activeJob && (
              <Link to={`/provisioning?tab=install&device=${deviceId}`} className="inline-flex h-7 items-center rounded-lg px-2.5 text-[13px] text-accent hover:bg-sunken">
                Install an OS
              </Link>
            )}
            <Button size="sm" variant="ghost" onClick={() => setCred(true)}>
              {s.configured ? 'BMC access' : 'Set up BMC access'}
            </Button>
          </div>
        )
      }
    >
      {!s.configured ? (
        <p className="text-ink-2">{canConfigure ? 'No BMC control account is set up for this server.' : 'Power control is not available for this server.'}</p>
      ) : (
        <>
          {s.credential && (
            <p className="mb-3 text-[13px] text-ink-3">
              {s.credential.kind === 'redfish' ? 'Redfish' : 'IPMI'} · {s.credential.username}@{s.credential.host}
              {s.credential.port ? `:${s.credential.port}` : ''} · set {formatDateTime(s.credential.rotatedAt)}
            </p>
          )}
          {s.activeJob ? (
            <div className="flex flex-wrap items-center gap-2">
              <JobStatusChip status={s.activeJob.status} />
              <span className="text-ink-2">{jobKindLabel(s.activeJob.kind)} in progress</span>
              <Button size="sm" variant="ghost" onClick={() => setJob(s.activeJob!.id)}>
                Details
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {POWER_ACTIONS.filter((a) => s.actions.includes(a)).map((a) => (
                <Button key={a} size="sm" variant="secondary" onClick={() => setAction(a)}>
                  {POWER_ACTION_LABELS[a]}
                </Button>
              ))}
            </div>
          )}
          {!!recent.data?.items.length && (
            <ul className="mt-4 flex flex-col gap-1.5 border-t border-rule pt-3 text-[13px]">
              {recent.data.items.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center gap-2">
                  <JobStatusChip status={j.status} cancelRequested={j.cancelRequested} verified={j.verified} />
                  <button className="text-accent hover:underline" onClick={() => setJob(j.id)}>
                    {j.kind === 'power_action' ? POWER_ACTION_LABELS[j.params.action as PowerAction] : jobKindLabel(j.kind)}
                  </button>
                  <span className="text-ink-3">
                    {j.createdBy} · {formatDateTime(j.createdAt)}
                  </span>
                  {j.error && !isActive(j.status) && <span className="w-full text-crit">{j.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <PowerActionDialog
        key={action ?? 'none'}
        deviceId={deviceId}
        name={s.name}
        action={action}
        onClose={() => setAction(null)}
        onQueued={(id) => {
          setAction(null);
          setJob(id);
          void qc.invalidateQueries({ queryKey: ['provisioning'] });
        }}
      />
      {cred && <ControlCredentialDialog deviceId={deviceId} current={s.credential} open onClose={() => setCred(false)} />}
      <JobModal id={job} onClose={() => setJob(null)} />
    </Panel>
  );
}
