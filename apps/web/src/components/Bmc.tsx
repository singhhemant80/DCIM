import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BMC_TYPES, BMC_TYPE_LABELS, type BmcType } from '@crapplet/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import { Button, Chip, ErrorNote, Field, Input, Loading, Modal, Panel, Select } from './ui';

/**
 * The server's BMC entered once (address and login) and used everywhere it
 * is needed: hardware, current health and power readings (read-only), and —
 * when ticked — power control and the consoles.
 */
export interface BmcStatusT {
  type: string | null;
  host: string | null;
  configured: boolean;
  monitoring: { kind: string; host: string; port: number | null; username: string | null; verifyTls: boolean | null; rotatedAt: string } | null;
  power: { enabled: boolean; kind: string; lastOkAt: string | null; lastWatts: number | null; lastError: string | null } | null;
  hardware: { at: string | null; error: string | null } | null;
  health: { at: string | null; error: string | null } | null;
  control: { kind: string; host: string; username: string; sameLogin: boolean; rotatedAt: string } | null;
  console: { sol: boolean; vnc: boolean };
}
export interface BmcResultT {
  use: 'monitoring' | 'power' | 'control' | 'serialConsole' | 'vnc';
  status: 'set' | 'skipped' | 'failed';
  message?: string;
}
const USE_LABEL: Record<BmcResultT['use'], string> = { monitoring: 'Monitoring (hardware, health)', power: 'Power readings', control: 'Power control', serialConsole: 'Serial console', vnc: 'Graphical console' };

export interface BmcLoginT {
  username: string;
  password: string;
  verifyTls: boolean;
  power: boolean;
  control: boolean;
  serialConsole: boolean;
  vncPassword: string;
  separateReadOnly: boolean;
  roUsername: string;
  roPassword: string;
}
export const emptyBmcLogin = (): BmcLoginT => ({ username: '', password: '', verifyTls: false, power: true, control: false, serialConsole: false, vncPassword: '', separateReadOnly: false, roUsername: '', roPassword: '' });
export const isBmcType = (t: string): t is BmcType => (BMC_TYPES as readonly string[]).includes(t);

export function bmcBody(type: BmcType, host: string, f: BmcLoginT) {
  return {
    type,
    host: host.trim(),
    username: f.username.trim(),
    password: f.password,
    verifyTls: f.verifyTls,
    power: f.power,
    control: f.control,
    serialConsole: f.serialConsole,
    vncPassword: f.vncPassword || null,
    readOnly: f.separateReadOnly && f.roUsername.trim() && f.roPassword ? { username: f.roUsername.trim(), password: f.roPassword } : null,
  };
}

export const putBmc = (deviceId: string, body: ReturnType<typeof bmcBody>) => api.put<{ results: BmcResultT[]; status: BmcStatusT }>(`/dcim/devices/${deviceId}/bmc`, body);

/** Results that need attention (a use skipped for lack of permission, or refused). */
export function BmcResults({ results }: { results: BmcResultT[] }) {
  const bad = results.filter((r) => r.status !== 'set');
  if (!bad.length) return null;
  return (
    <ul className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-[13px]">
      {bad.map((r) => (
        <li key={r.use}>
          <span className="font-medium">{USE_LABEL[r.use]}</span>: {r.status === 'skipped' ? 'not set' : 'failed'} — {r.message}
        </li>
      ))}
    </ul>
  );
}

/** Login and uses; shared by the add / edit server form and the BMC panel. */
export function BmcLoginFields({ f, setF, type, keepHint }: { f: BmcLoginT; setF: (u: (x: BmcLoginT) => BmcLoginT) => void; type: BmcType; keepHint?: string }) {
  const { can } = useAuth();
  const set = (k: keyof BmcLoginT) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const tick = (k: keyof BmcLoginT) => (e: { target: { checked: boolean } }) => setF((x) => ({ ...x, [k]: e.target.checked }));
  const ipmi = type === 'ipmi';
  const box = 'flex items-start gap-2 text-[13px]';
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="BMC user name">{(id) => <Input id={id} autoComplete="off" value={f.username} onChange={set('username')} placeholder={type === 'idrac' ? 'root' : type === 'ilo' ? 'Administrator' : 'admin'} />}</Field>
        <Field label="BMC password" hint={keepHint}>
          {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={f.password} onChange={set('password')} />}
        </Field>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-[13px] font-medium">Use this BMC for</legend>
        <label className={box}>
          <input type="checkbox" checked disabled className="mt-0.5" /> Hardware inventory, health every 5 minutes and BMC ping (read-only, always)
        </label>
        {can('power.configure') && (
          <label className={box}>
            <input type="checkbox" className="mt-0.5" checked={f.power} onChange={tick('power')} /> Power readings (watts, energy)
          </label>
        )}
        {can('provisioning.execute') && (
          <label className={box}>
            <input type="checkbox" className="mt-0.5" checked={f.control} onChange={tick('control')} /> Power control and OS installs (on / off / restart — the login needs operator or administrator rights)
          </label>
        )}
        {can('hardware.console') && can('provisioning.execute') && (
          <>
            <label className={box}>
              <input type="checkbox" className="mt-0.5" checked={f.serialConsole} onChange={tick('serialConsole')} /> Serial console (IPMI over LAN must be enabled on the BMC)
            </label>
            <div className="max-w-sm pl-6">
              <Field label="VNC password (optional)" hint="For the graphical console: the BMC's VNC server password (iDRAC: iDRAC Settings → Services → VNC Server)">
                {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={f.vncPassword} onChange={set('vncPassword')} />}
              </Field>
            </div>
          </>
        )}
      </fieldset>
      {!ipmi && (
        <label className={box}>
          <input type="checkbox" className="mt-0.5" checked={f.verifyTls} onChange={tick('verifyTls')} /> Verify the BMC's TLS certificate (leave off for the factory self-signed certificate)
        </label>
      )}
      <label className={box}>
        <input type="checkbox" className="mt-0.5" checked={f.separateReadOnly} onChange={tick('separateReadOnly')} /> Use a separate read-only account for monitoring (recommended when the login above can change settings)
      </label>
      {f.separateReadOnly && (
        <div className="grid gap-4 pl-6 sm:grid-cols-2">
          <Field label="Read-only user name">{(id) => <Input id={id} autoComplete="off" value={f.roUsername} onChange={set('roUsername')} />}</Field>
          <Field label="Read-only password">{(id) => <Input id={id} type="password" autoComplete="new-password" value={f.roPassword} onChange={set('roPassword')} />}</Field>
        </div>
      )}
    </div>
  );
}

function SetupDialog({ deviceId, status, onClose }: { deviceId: string; status: BmcStatusT; onClose: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState<BmcType>(status.type && isBmcType(status.type) ? status.type : 'idrac');
  const [host, setHost] = useState(status.host ?? '');
  const [f, setF] = useState<BmcLoginT>(() => ({
    ...emptyBmcLogin(),
    username: status.control?.username ?? status.monitoring?.username ?? '',
    power: status.power ? status.power.enabled : true,
    control: !!status.control,
    serialConsole: status.console.sol,
    verifyTls: !!status.monitoring?.verifyTls,
  }));
  const [results, setResults] = useState<BmcResultT[] | null>(null);
  const m = useMutation({
    mutationFn: () => putBmc(deviceId, bmcBody(type, host, f)),
    onSuccess: async (r) => {
      await qc.invalidateQueries();
      if (r.results.some((x) => x.status !== 'set')) setResults(r.results);
      else onClose();
    },
  });
  return (
    <Modal
      wide
      open
      onOpenChange={(o) => !o && onClose()}
      title={status.configured ? 'Change BMC' : 'Set up BMC'}
      description="Enter the BMC once; NexoraDC uses it for hardware, health, power readings and, if ticked, power control and the consoles. Passwords are stored encrypted and never shown again."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Management controller">
            {(id) => (
              <Select id={id} value={type} onChange={(e) => setType(e.target.value as BmcType)}>
                {BMC_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {BMC_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="BMC address">{(id) => <Input id={id} required className="font-mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.0.0.21" />}</Field>
        </div>
        <BmcLoginFields f={f} setF={setF} type={type} />
        <ErrorNote error={m.error} />
        {results && <BmcResults results={results} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {results ? 'Close' : 'Cancel'}
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!host.trim() || !f.username.trim() || !f.password}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const Row = ({ label, ok, children }: { label: string; ok: boolean | null; children: React.ReactNode }) => (
  <div className="flex items-start justify-between gap-3 border-t border-rule py-2 first:border-t-0">
    <span className="text-ink-2">{label}</span>
    <span className="text-right">{ok === null ? <span className="text-ink-3">{children}</span> : <Chip tone={ok ? 'ok' : 'warn'}>{children}</Chip>}</span>
  </div>
);

/** Device page: the BMC, and where it is used. */
export function BmcPanel({ deviceId, canWrite }: { deviceId: string; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['dcim', 'bmc', deviceId], queryFn: () => api.get<BmcStatusT>(`/dcim/devices/${deviceId}/bmc`) });
  const s = q.data;
  return (
    <Panel
      title="BMC"
      actions={
        canWrite && s ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            {s.configured ? 'Change' : 'Set up BMC'}
          </Button>
        ) : undefined
      }
    >
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} />
      {s && !s.configured && (
        <p className="text-[13px] text-ink-2">Enter the iDRAC / iLO / iRMC address and login once. Hardware, health every 5 minutes, power readings, the BMC ping and — if you tick them — power control and the consoles all use it.</p>
      )}
      {s?.configured && s.monitoring && (
        <div className="text-[13px]">
          <div className="mb-2 font-mono text-[12.5px] text-ink-2">
            {s.type && isBmcType(s.type) ? `${BMC_TYPE_LABELS[s.type]} · ` : ''}
            {s.monitoring.username}@{s.monitoring.host}
            {s.monitoring.port ? `:${s.monitoring.port}` : ''} · set {relativeTime(s.monitoring.rotatedAt)}
          </div>
          <Row label="Hardware inventory" ok={s.hardware?.at ? !s.hardware.error : s.hardware?.error ? false : null}>
            {s.hardware?.error ? 'Read failed' : s.hardware?.at ? `Read ${relativeTime(s.hardware.at)}` : 'Reading…'}
          </Row>
          <Row label="Health (every 5 min)" ok={s.health?.error ? false : s.health?.at ? true : null}>
            {s.health?.error ? 'Read failed' : s.health?.at ? `Read ${relativeTime(s.health.at)}` : 'Reading…'}
          </Row>
          <Row label="Power readings" ok={!s.power?.enabled ? null : s.power.lastError ? false : s.power.lastOkAt ? true : null}>
            {!s.power ? 'Not used' : !s.power.enabled ? 'Off' : s.power.lastError ? 'Failing' : s.power.lastWatts !== null ? `${Math.round(s.power.lastWatts)} W` : 'Waiting for first reading'}
          </Row>
          <Row label="Power control" ok={s.control ? true : null}>
            {s.control ? (s.control.sameLogin ? 'Same login' : `${s.control.username}@${s.control.host}`) : 'Not used'}
          </Row>
          <Row label="Consoles" ok={s.console.sol || s.console.vnc ? true : null}>
            {[s.console.sol && 'Serial', s.console.vnc && 'Graphical'].filter(Boolean).join(' + ') || 'Web interface link only'}
          </Row>
          {(s.health?.error || s.hardware?.error) && <p className="mt-1 text-[12.5px] break-words text-warn">{s.health?.error ?? s.hardware?.error}</p>}
        </div>
      )}
      {open && s && <SetupDialog deviceId={deviceId} status={s} onClose={() => setOpen(false)} />}
    </Panel>
  );
}
