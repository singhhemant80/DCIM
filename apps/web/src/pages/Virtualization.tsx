import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { GUEST_ACTIONS, GUEST_ACTION_LABELS, GUEST_SORTS, type GuestAction, type VirtTemplate } from '@crapplet/shared';

type GuestSort = (typeof GUEST_SORTS)[number];
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import type { DeviceT } from '../lib/dcim';
import { bytes, duration, newIdempotencyKey, type IntegrationT, type JobT, type VirtGuestT, type VirtHostT } from '../lib/provisioning';
import { JobModal } from '../components/Jobs';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Panel, Select, Table, cx } from '../components/ui';

type Kind = 'proxmox' | 'virtualizor';
const NAME: Record<Kind, string> = { proxmox: 'Proxmox VE', virtualizor: 'Virtualizor' };
interface Customer {
  id: string;
  name: string;
  code: string;
}

const statusTone = (s: string | null) =>
  s === 'running' || s === 'online' ? 'ok' : s === 'stopped' || s === 'offline' ? 'neutral' : s === 'suspended' || s === 'network_suspended' || s === 'paused' ? 'warn' : s === 'locked' ? 'crit' : 'neutral';
/** VM states as people say them: running → Online, stopped → Offline. */
const GUEST_STATUS_LABELS: Record<string, string> = { running: 'Online', stopped: 'Offline', suspended: 'Suspended', network_suspended: 'Network suspended', locked: 'Locked', paused: 'Paused', missing: 'Missing', unknown: 'Unknown' };
const guestStatusLabel = (s: string | null) => (s ? (GUEST_STATUS_LABELS[s] ?? s) : 'Unknown');
/** Status filter chips: value sent as ?status=, label; "missing" = no longer reported by the hypervisor. */
const STATUS_FILTERS: [string, string][] = [
  ['', 'All'],
  ['running', 'Online'],
  ['stopped', 'Offline'],
  ['suspended', 'Suspended'],
  ['network_suspended', 'Network suspended'],
  ['locked', 'Locked'],
  ['paused', 'Paused'],
  ['unknown', 'Unknown'],
  ['missing', 'Missing'],
];
const STATUS_DOT: Record<string, string> = { running: 'bg-ok', stopped: 'bg-ink-3', suspended: 'bg-warn', network_suspended: 'bg-warn', locked: 'bg-crit', paused: 'bg-warn', unknown: 'bg-ink-3/50', missing: 'bg-warn' };
type GuestListT = Paginated<VirtGuestT> & { facets: { status: Record<string, number>; virtType: { value: string; count: number }[]; osName: { value: string; count: number }[] } };

/* ------------------------------------------------------------------ integration form */

function IntegrationDialog({ kind, current, onClose }: { kind: Kind; current: IntegrationT | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(current?.name ?? '');
  const [url, setUrl] = useState(current?.url ?? '');
  const [verifyTls, setVerifyTls] = useState(current?.verifyTls ?? true);
  const [tokenId, setTokenId] = useState(current?.params.tokenId ?? '');
  const [tokenSecret, setTokenSecret] = useState('');
  const [actionTokenId, setActionTokenId] = useState(current?.params.actionTokenId ?? '');
  const [actionTokenSecret, setActionTokenSecret] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiPass, setApiPass] = useState('');
  const [actionsEnabled, setActionsEnabled] = useState(current?.actionsEnabled ?? false);
  const [syncMinutes, setSyncMinutes] = useState(String(current?.syncMinutes ?? (kind === 'proxmox' ? 5 : 10)));
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const save = useMutation({
    mutationFn: () => {
      const common = { kind, name, url: url.trim(), verifyTls, syncMinutes: Number(syncMinutes), enabled };
      const body =
        kind === 'proxmox'
          ? { ...common, tokenId: tokenId.trim(), tokenSecret, actionTokenId: actionTokenId.trim() || null, actionTokenSecret: actionTokenSecret || null }
          : { ...common, apiKey: apiKey.trim(), apiPass, actionsEnabled };
      return current ? api.put(`/virtualization/integrations/${current.id}`, body) : api.post('/virtualization/integrations', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['virt'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={current ? `Edit ${current.name}` : `Add ${NAME[kind]}`}
      description={
        kind === 'proxmox'
          ? 'Inventory sync uses a read-only API token (role PVEAuditor). VM actions are possible only if you add a second token with VM.PowerMgmt. Secrets are write-only.'
          : 'Virtualizor admin API keys cannot be limited to reading, so VM actions stay off until you turn them on here. Secrets are write-only.'
      }
      wide
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
          <Field label="Sync every (minutes)">{(id) => <Input id={id} inputMode="numeric" value={syncMinutes} onChange={(e) => setSyncMinutes(e.target.value.replace(/\D/g, ''))} />}</Field>
        </div>
        <Field label="API address" hint={kind === 'proxmox' ? 'For example https://pve1.example.net:8006' : 'The admin panel, for example https://vz.example.net:4085'}>
          {(id) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} required />}
        </Field>
        {kind === 'proxmox' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Read token ID">{(id) => <Input id={id} value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="dcim@pve!read" required />}</Field>
              <Field label="Read token secret">{(id) => <Input id={id} type="password" autoComplete="new-password" value={tokenSecret} onChange={(e) => setTokenSecret(e.target.value)} required />}</Field>
              <Field label="Action token ID (optional)">{(id) => <Input id={id} value={actionTokenId} onChange={(e) => setActionTokenId(e.target.value)} placeholder="dcim@pve!ops" />}</Field>
              <Field label="Action token secret">{(id) => <Input id={id} type="password" autoComplete="new-password" value={actionTokenSecret} onChange={(e) => setActionTokenSecret(e.target.value)} />}</Field>
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="API key">{(id) => <Input id={id} autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />}</Field>
              <Field label="API password">{(id) => <Input id={id} type="password" autoComplete="new-password" value={apiPass} onChange={(e) => setApiPass(e.target.value)} required />}</Field>
            </div>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={actionsEnabled} onChange={(e) => setActionsEnabled(e.target.checked)} /> Allow VM actions (start, shut down, power off, reboot) from DCIM
            </label>
          </>
        )}
        {current && <p className="text-[12.5px] text-ink-3">Secrets are never shown; enter them again to save changes.</p>}
        <div className="flex flex-wrap gap-4 text-[13px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={verifyTls} onChange={(e) => setVerifyTls(e.target.checked)} /> Verify the TLS certificate
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
          </label>
        </div>
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2">
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

/* ------------------------------------------------------------------ integrations and hosts (staff) */

function Integrations({ kind, list }: { kind: Kind; list: IntegrationT[] }) {
  const { can } = useAuth();
  const canExecute = can('provisioning.execute');
  const qc = useQueryClient();
  const [edit, setEdit] = useState<IntegrationT | 'new' | null>(null);
  const [deleting, setDeleting] = useState<IntegrationT | null>(null);
  const sync = useMutation({ mutationFn: (id: string) => api.post(`/virtualization/integrations/${id}/sync`), onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ['virt'] }), 3000) });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/virtualization/integrations/${id}`),
    onSuccess: () => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['virt'] });
    },
  });
  return (
    <Panel
      flush
      title="Connections"
      actions={
        canExecute && (
          <Button size="sm" variant="primary" onClick={() => setEdit('new')}>
            Add {NAME[kind]}
          </Button>
        )
      }
    >
      {!list.length ? (
        <EmptyState title={`No ${NAME[kind]} connected`}>{kind === 'proxmox' ? 'Create an API token with the PVEAuditor role and add it here to see nodes and VMs.' : 'Add the panel’s admin API key to see servers and VPSes.'}</EmptyState>
      ) : (
        <Table label="Connections">
          <thead>
            <tr>
              <th>Name</th>
              <th>Inventory</th>
              <th>Last sync</th>
              <th>VM actions</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((i) => (
              <tr key={i.id}>
                <td>
                  <div className="font-medium">
                    {i.name} {!i.enabled && <Chip>Disabled</Chip>}
                  </div>
                  <div className="text-[12.5px] text-ink-3">{i.url}</div>
                </td>
                <td className="text-[13px]">
                  {i.hosts} host{i.hosts === 1 ? '' : 's'} · {i.guests} VM{i.guests === 1 ? '' : 's'}
                </td>
                <td className="text-[13px]">
                  {i.lastSyncAt ? (
                    <Chip tone={i.lastSyncOk ? 'ok' : 'crit'} title={i.lastError ?? undefined}>
                      {i.lastSyncOk ? 'OK' : 'Failed'} · {relativeTime(i.lastSyncAt)}
                    </Chip>
                  ) : (
                    <span className="text-ink-3">Not yet</span>
                  )}
                  {i.lastError && <div className={cx('mt-1 max-w-[60ch] text-[12px] leading-snug break-words', i.lastSyncOk ? 'text-warn' : 'text-crit')}>{i.lastError}</div>}
                </td>
                <td className="text-[13px]">{i.actionsEnabled ? <Chip tone="accent">Allowed</Chip> : <Chip>Read-only</Chip>}</td>
                <td className="text-right whitespace-nowrap">
                  {canExecute && (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" busy={sync.isPending && sync.variables === i.id} onClick={() => sync.mutate(i.id)}>
                        Sync now
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEdit(i)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" className="text-crit" onClick={() => (remove.reset(), setDeleting(i))}>
                        Remove
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <ErrorNote error={sync.error} className="m-4" />
      {edit && <IntegrationDialog kind={kind} current={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove ${deleting?.name ?? ''}?`}
        body="DCIM forgets its hosts, VMs and their customer assignments. Nothing changes on the hypervisor."
        confirmLabel="Remove"
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Panel>
  );
}

function Hosts({ kind, integrations, nodeId, onNode }: { kind: Kind; integrations: IntegrationT[]; nodeId: string; onNode: (id: string) => void }) {
  const { can } = useAuth();
  const canExecute = can('provisioning.execute');
  const qc = useQueryClient();
  const ids = new Set(integrations.map((i) => i.id));
  const q = useQuery({ queryKey: ['virt', 'hosts'], queryFn: () => api.get<VirtHostT[]>('/virtualization/hosts') });
  const servers = useQuery({ queryKey: ['dcim', 'devices', 'servers-all'], queryFn: () => api.get<Paginated<DeviceT>>('/dcim/devices?category=server&pageSize=200'), enabled: canExecute });
  const map = useMutation({ mutationFn: (v: { id: string; deviceId: string | null }) => api.put(`/virtualization/hosts/${v.id}/device`, { deviceId: v.deviceId }), onSuccess: () => qc.invalidateQueries({ queryKey: ['virt', 'hosts'] }) });
  const hosts = (q.data ?? []).filter((h) => ids.has(h.integrationId));
  if (!integrations.length) return null;
  return (
    <Panel flush title={kind === 'proxmox' ? 'Nodes' : 'Servers'}>
      {q.isLoading ? (
        <Loading />
      ) : !hosts.length ? (
        <EmptyState title="Nothing synced yet" />
      ) : (
        <Table label="Hosts">
          <thead>
            <tr>
              <th>Host</th>
              <th>Status</th>
              <th>CPU</th>
              <th>Memory</th>
              <th>VMs</th>
              <th>DCIM server</th>
            </tr>
          </thead>
          <tbody>
            {hosts.map((h) => (
              <tr key={h.id} className={cx(h.missingSince && 'opacity-60', nodeId === h.id && 'bg-accent-soft')}>
                <td>
                  <div className="font-medium">{h.name}</div>
                  <div className="text-[12.5px] text-ink-3">
                    {h.integrationName}
                    {h.uptimeSeconds ? ` · up ${duration(h.uptimeSeconds)}` : ''}
                  </div>
                </td>
                <td>{h.missingSince ? <Chip tone="warn">Missing since {relativeTime(h.missingSince)}</Chip> : <Chip tone={statusTone(h.status)}>{h.status ?? 'unknown'}</Chip>}</td>
                <td className="text-[13px]">
                  {h.cpuPct !== null ? `${h.cpuPct}%` : '—'}
                  {h.cpus ? ` of ${h.cpus}` : ''}
                </td>
                <td className="text-[13px]">{h.memTotal ? `${h.memUsed !== null ? `${bytes(h.memUsed)} / ` : ''}${bytes(h.memTotal)}` : '—'}</td>
                <td>
                  <button type="button" className="text-accent hover:underline" title={`Show only the VMs on ${h.name}`} onClick={() => onNode(nodeId === h.id ? '' : h.id)}>
                    {h.guests} {nodeId === h.id ? '· showing' : '· show'}
                  </button>
                </td>
                <td>
                  {canExecute ? (
                    <Select className="w-52" aria-label={`DCIM server for ${h.name}`} value={h.deviceId ?? ''} onChange={(e) => map.mutate({ id: h.id, deviceId: e.target.value || null })}>
                      <option value="">Not linked</option>
                      {h.deviceId && !servers.data?.items.some((d) => d.id === h.deviceId) && <option value={h.deviceId}>{h.deviceName}</option>}
                      {servers.data?.items.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.hostname ?? d.assetTag}
                        </option>
                      ))}
                    </Select>
                  ) : h.deviceId ? (
                    <Link className="text-accent hover:underline" to={`/hardware/${h.deviceId}`}>
                      {h.deviceName}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="border-t border-rule px-4 py-2 text-[12.5px] text-ink-3">Hosts are linked to DCIM servers only by an operator; DCIM does not guess the link from names.</p>
      <ErrorNote error={map.error} className="m-4" />
    </Panel>
  );
}

/* ------------------------------------------------------------------ guests */

function GuestActionDialog({ guest, onClose, onQueued }: { guest: VirtGuestT; onClose: () => void; onQueued: (id: string) => void }) {
  const [action, setAction] = useState<GuestAction>(guest.status === 'running' ? 'shutdown' : guest.status === 'suspended' && guest.integrationKind === 'proxmox' ? 'resume' : 'start');
  const [confirm, setConfirm] = useState('');
  const [key] = useState(newIdempotencyKey);
  const m = useMutation({ mutationFn: () => api.post<JobT>(`/virtualization/guests/${guest.id}/actions`, { action, confirm }, { 'Idempotency-Key': `${key}:${action}` }), onSuccess: (j) => onQueued(j.id) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`VM action: ${guest.name}`} description="The job finishes only when the hypervisor reports the VM in the expected state.">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Action" hint={action === 'stop' ? 'Cuts the VM off like pulling the power cord.' : action === 'shutdown' ? 'Asks the guest OS to shut down; fails if it does not within 5 minutes.' : undefined}>
          {(id) => (
            <Select id={id} value={action} onChange={(e) => setAction(e.target.value as GuestAction)}>
              {GUEST_ACTIONS.filter((a) => guest.integrationKind !== 'virtualizor' || (a !== 'suspend' && a !== 'resume')).map((a) => (
                <option key={a} value={a}>
                  {GUEST_ACTION_LABELS[a]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={`Type ${guest.name} to confirm`}>{(id) => <Input id={id} autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />}</Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={action === 'stop' ? 'danger' : 'primary'} busy={m.isPending} disabled={confirm.trim().toLowerCase() !== guest.name.toLowerCase()}>
            {GUEST_ACTION_LABELS[action]}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** A random root password from an unambiguous alphabet (no 0/O, 1/l/I). */
function newPassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = new Uint32Array(20);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => abc[x % abc.length]).join('');
}

function ReinstallDialog({ guest, onClose, onQueued }: { guest: VirtGuestT; onClose: () => void; onQueued: (id: string) => void }) {
  const t = useQuery({
    queryKey: ['virt', 'templates', guest.id],
    queryFn: () => api.get<{ supported: boolean; actionsEnabled: boolean; currentOs: string | null; synced: boolean; items: VirtTemplate[]; matchedType: boolean }>(`/virtualization/guests/${guest.id}/templates`),
  });
  const [osid, setOsid] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [primaryOnly, setPrimaryOnly] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [key] = useState(newIdempotencyKey);
  const m = useMutation({
    mutationFn: () => api.post<JobT>(`/virtualization/guests/${guest.id}/reinstall`, { osid: Number(osid), password, confirm, formatPrimaryOnly: primaryOnly }, { 'Idempotency-Key': `${key}:${osid}` }),
    onSuccess: (j) => onQueued(j.id),
  });
  const items = t.data?.items ?? [];
  const groups = new Map<string, VirtTemplate[]>();
  for (const x of items) groups.set(x.distro ?? 'Other', [...(groups.get(x.distro ?? 'Other') ?? []), x]);
  const kvmLike = /kvm|proxk|xen/i.test(guest.virtType ?? '');
  const ready = !!osid && password.length >= 8 && confirm.trim().toLowerCase() === guest.name.toLowerCase();
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Reinstall ${guest.name}`} description="Installs a fresh operating system from the hypervisor's OS templates." wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) m.mutate();
        }}
      >
        <div className="rounded-lg border border-crit/40 bg-crit-soft px-3 py-2 text-[13px]">
          <strong>Everything on this VM's disk{kvmLike && primaryOnly ? ' (primary disk)' : ''} is erased.</strong> {t.data?.currentOs ? `It now runs ${t.data.currentOs}. ` : ''}The VM keeps its addresses and resources; take a backup first
          if anything on it matters.
        </div>
        {t.isLoading && <Loading />}
        <ErrorNote error={t.error} />
        {t.data && !t.data.synced && <p className="text-[13px] text-warn">The OS templates have not been read yet. Press Sync now on the connection, then try again.</p>}
        {t.data && t.data.synced && !items.length && <p className="text-[13px] text-warn">Virtualizor lists no installed OS templates. Download some in Virtualizor (Media → OS Templates) and sync again.</p>}
        {items.length > 0 && (
          <Field label="Operating system" hint={t.data && !t.data.matchedType ? `No template is marked for ${guest.virtType ?? 'this VM type'}; all are listed and Virtualizor refuses one that doesn't fit.` : undefined}>
            {(id) => (
              <Select id={id} value={osid} onChange={(e) => setOsid(e.target.value)} required>
                <option value="">Choose a template…</option>
                {[...groups].map(([distro, list]) => (
                  <optgroup key={distro} label={distro}>
                    {list.map((x) => (
                      <option key={x.osid} value={x.osid}>
                        {x.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="New root password" hint="At least 8 characters. Sent to Virtualizor once for the install; NexoraDC does not keep it. Save it before you start.">
          {(id) => (
            <div className="flex gap-2">
              <Input id={id} type={show ? 'text' : 'password'} autoComplete="new-password" className="font-mono" value={password} onChange={(e) => setPassword(e.target.value)} />
              <Button type="button" variant="ghost" onClick={() => setShow((v) => !v)}>
                {show ? 'Hide' : 'Show'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setPassword(newPassword());
                  setShow(true);
                }}
              >
                Generate
              </Button>
            </div>
          )}
        </Field>
        {kvmLike && (
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={primaryOnly} onChange={(e) => setPrimaryOnly(e.target.checked)} /> Format only the primary disk (keep additional disks)
          </label>
        )}
        <Field label={`Type ${guest.name} to confirm`}>{(id) => <Input id={id} autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" busy={m.isPending} disabled={!ready}>
            Erase and reinstall
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Guests({ kind, integrations, staff, nodeId, onNode }: { kind: Kind; integrations: IntegrationT[] | null; staff: boolean; nodeId: string; onNode: (id: string) => void }) {
  const { can, me } = useAuth();
  const canControl = can('hardware.control');
  const canAssign = staff && can('provisioning.execute');
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [virtType, setVirtType] = useState('');
  const [osName, setOsName] = useState('');
  const [sort, setSort] = useState<GuestSort>('name');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const filtered = !!(status || customerFilter || virtType || osName || search.trim() || nodeId);
  const clearAll = () => {
    setStatus('');
    setCustomerFilter('');
    setVirtType('');
    setOsName('');
    setSearch('');
    onNode('');
    setPage(1);
  };
  const sortBy = (k: GuestSort) => {
    if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else (setSort(k), setDir(k === 'name' || k === 'server' || k === 'customer' || k === 'status' ? 'asc' : 'desc'));
    setPage(1);
  };
  const SortTh = ({ k, children, className }: { k: GuestSort; children: React.ReactNode; className?: string }) => (
    <th className={className} aria-sort={sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => sortBy(k)}>
        {children}
        <span className={cx('text-[10px]', sort === k ? 'text-ink' : 'text-ink-3/50')} aria-hidden>
          {sort === k && dir === 'desc' ? '▼' : '▲'}
        </span>
      </button>
    </th>
  );
  const [page, setPage] = useState(1);
  const [integrationId, setIntegrationId] = useState('');
  const [act, setAct] = useState<VirtGuestT | null>(null);
  const [reinstall, setReinstall] = useState<VirtGuestT | null>(null);
  const hosts = useQuery({ queryKey: ['virt', 'hosts'], queryFn: () => api.get<VirtHostT[]>('/virtualization/hosts'), enabled: staff });
  const ids = new Set((integrations ?? []).map((i) => i.id));
  const nodes = (hosts.data ?? []).filter((h) => ids.has(h.integrationId) && (!integrationId || h.integrationId === integrationId)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  useEffect(() => setPage(1), [nodeId]);
  const [job, setJob] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['virt', 'guests', kind, integrationId, nodeId, search, status, customerFilter, virtType, osName, sort, dir, page],
    queryFn: () =>
      api.get<GuestListT>(
        `/virtualization/guests${qs({ kind, integrationId: integrationId || undefined, hostId: nodeId || undefined, q: search.trim() || undefined, status: status || undefined, customerId: customerFilter || undefined, virtType: virtType || undefined, osName: osName || undefined, sort, dir, page, pageSize: 50 })}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.items.some((g) => g.activeJob) ? 4000 : 60_000),
  });
  const customers = useQuery({ queryKey: ['customers', 'options'], queryFn: () => api.get<Paginated<Customer>>('/customers?pageSize=200'), enabled: canAssign });
  const assign = useMutation({ mutationFn: (v: { id: string; customerId: string | null }) => api.put(`/virtualization/guests/${v.id}/customer`, { customerId: v.customerId }), onSuccess: () => qc.invalidateQueries({ queryKey: ['virt', 'guests'] }) });
  const items = q.data?.items ?? [];
  const facets = q.data?.facets;
  const customerOptions = useQuery({ queryKey: ['customers', 'options'], queryFn: () => api.get<Paginated<Customer>>('/customers?pageSize=200'), enabled: staff });
  return (
    <Panel
      flush
      title={staff ? (nodeId && nodes.find((h) => h.id === nodeId) ? `Virtual machines on ${nodes.find((h) => h.id === nodeId)!.name}` : 'Virtual machines') : 'Your virtual machines'}
      actions={
        <div className="flex gap-2">
          {staff && integrations && integrations.length > 1 && (
            <Select className="w-44" aria-label="Connection" value={integrationId} onChange={(e) => (setIntegrationId(e.target.value), setPage(1))}>
              <option value="">All connections</option>
              {integrations.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          )}
          {staff && nodes.length > 0 && (
            <Select className="w-44" aria-label={kind === 'proxmox' ? 'Node' : 'Server'} value={nodeId} onChange={(e) => onNode(e.target.value)}>
              <option value="">{kind === 'proxmox' ? 'All nodes' : 'All servers'}</option>
              {nodes.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} ({h.guests})
                </option>
              ))}
            </Select>
          )}
          <Input className="w-48" aria-label="Search" placeholder="Name, ID, IP or OS" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
        </div>
      }
    >
      <div className="flex flex-col gap-2 border-b border-rule px-4 py-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Status">
          {STATUS_FILTERS.map(([k, label]) => {
            const n = k ? (facets?.status[k] ?? 0) : Object.values(facets?.status ?? {}).reduce((a, x) => a + x, 0);
            if (k && !n && status !== k) return null;
            return (
              <button
                key={k || 'all'}
                type="button"
                aria-pressed={status === k}
                onClick={() => (setStatus(k), setPage(1))}
                className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px]', status === k ? 'border-accent bg-accent-soft font-medium text-ink' : 'border-rule bg-panel text-ink-2 hover:border-accent/50')}
              >
                {k && <span className={cx('size-1.5 rounded-full', STATUS_DOT[k] ?? 'bg-ink-3')} aria-hidden />}
                {label}
                <span className="text-ink-3 tabular-nums">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {staff && (
            <Select className="w-48" aria-label="Customer" value={customerFilter} onChange={(e) => (setCustomerFilter(e.target.value), setPage(1))}>
              <option value="">All customers</option>
              <option value="own">{me?.organization.name ?? 'Own'} (own)</option>
              {customerOptions.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
          {(facets?.virtType.length ?? 0) > 1 || virtType ? (
            <Select className="w-36" aria-label="Type" value={virtType} onChange={(e) => (setVirtType(e.target.value), setPage(1))}>
              <option value="">All types</option>
              {facets?.virtType.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.value} ({x.count})
                </option>
              ))}
            </Select>
          ) : null}
          {(facets?.osName.length ?? 0) > 1 || osName ? (
            <Select className="w-56" aria-label="Operating system" value={osName} onChange={(e) => (setOsName(e.target.value), setPage(1))}>
              <option value="">All operating systems</option>
              {facets?.osName.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.value === 'none' ? 'Not reported' : x.value} ({x.count})
                </option>
              ))}
            </Select>
          ) : null}
          {filtered && (
            <Button size="sm" variant="ghost" onClick={clearAll}>
              Clear filters
            </Button>
          )}
          {q.data && (
            <span className="ml-auto text-[12.5px] text-ink-3">
              {q.data.total} VM{q.data.total === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorNote error={q.error} className="m-4" />
      ) : !items.length ? (
        <EmptyState title={filtered ? 'No matching virtual machines' : 'No virtual machines'}>
          {filtered ? 'Change or clear the filters.' : staff ? 'VMs appear after the first sync.' : 'No VMs have been assigned to your account.'}
        </EmptyState>
      ) : (
        <Table label="Virtual machines">
          <thead>
            <tr>
              <SortTh k="name">VM</SortTh>
              <SortTh k="status">Status</SortTh>
              <th>
                Resources{' '}
                <span className="font-normal text-ink-3">
                  (sort:{' '}
                  {(
                    [
                      ['cpus', 'CPU'],
                      ['memory', 'RAM'],
                      ['disk', 'disk'],
                    ] as const
                  ).map(([k, l], i) => (
                    <span key={k}>
                      {i > 0 && ' · '}
                      <button type="button" className={cx('hover:text-ink', sort === k && 'font-medium text-ink')} onClick={() => sortBy(k)}>
                        {l}
                        {sort === k ? (dir === 'desc' ? ' ▼' : ' ▲') : ''}
                      </button>
                    </span>
                  ))}
                  )
                </span>
              </th>
              <th>Addresses</th>
              {staff && <SortTh k="customer">Customer</SortTh>}
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((g) => (
              <tr key={g.id} className={g.missingSince ? 'opacity-60' : ''}>
                <td>
                  <div className="font-medium">{g.name}</div>
                  <div className="text-[12.5px] text-ink-3">
                    #{g.externalId}
                    {g.virtType ? ` · ${g.virtType}` : ''}
                    {g.hostName ? ` · ${g.hostName}` : ''}
                  </div>
                  {g.osName && <div className="text-[12.5px] text-ink-2">{g.osName}</div>}
                </td>
                <td>
                  {g.missingSince ? (
                    <Chip tone="warn" title="No longer reported by the hypervisor; kept with its assignment">
                      Missing since {relativeTime(g.missingSince)}
                    </Chip>
                  ) : (
                    <Chip tone={statusTone(g.status)}>{guestStatusLabel(g.status)}</Chip>
                  )}
                  {g.activeJob && <div className="mt-1 text-[12px] text-accent">Action in progress</div>}
                </td>
                <td className="text-[13px]">
                  {g.cpus ?? '—'} vCPU · {bytes(g.memBytes)}
                  {g.diskBytes ? ` · ${bytes(g.diskBytes)} disk` : ''}
                </td>
                <td className="font-mono text-[12px]">{g.ipAddresses.length ? g.ipAddresses.join(', ') : <span className="font-sans text-ink-3">Not reported</span>}</td>
                {staff && (
                  <td>
                    {canAssign ? (
                      <Select className="w-44" aria-label={`Customer for ${g.name}`} value={g.customerId ?? ''} onChange={(e) => assign.mutate({ id: g.id, customerId: e.target.value || null })}>
                        <option value="">{me?.organization.name ?? 'Own'} (own)</option>
                        {customers.data?.items.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      (g.customerName ?? '—')
                    )}
                  </td>
                )}
                <td className="text-right whitespace-nowrap">
                  {canControl && g.actionsEnabled && !g.missingSince && (
                    <Button size="sm" variant="ghost" disabled={!!g.activeJob} onClick={() => setAct(g)}>
                      Actions
                    </Button>
                  )}
                  {staff && canControl && g.actionsEnabled && !g.missingSince && g.integrationKind === 'virtualizor' && (
                    <Button size="sm" variant="ghost" disabled={!!g.activeJob} onClick={() => setReinstall(g)}>
                      Reinstall
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {q.data && q.data.total > q.data.pageSize && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />}
      <ErrorNote error={assign.error} className="m-4" />
      {act && (
        <GuestActionDialog
          guest={act}
          onClose={() => setAct(null)}
          onQueued={(id) => {
            setAct(null);
            setJob(id);
            void qc.invalidateQueries({ queryKey: ['virt', 'guests'] });
          }}
        />
      )}
      {reinstall && (
        <ReinstallDialog
          guest={reinstall}
          onClose={() => setReinstall(null)}
          onQueued={(id) => {
            setReinstall(null);
            setJob(id);
            void qc.invalidateQueries({ queryKey: ['virt', 'guests'] });
          }}
        />
      )}
      <JobModal id={job} onClose={() => setJob(null)} />
    </Panel>
  );
}

/* ------------------------------------------------------------------ page */

function VirtualizationPage({ kind }: { kind: Kind }) {
  const { me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const q = useQuery({ queryKey: ['virt', 'integrations'], queryFn: () => api.get<IntegrationT[]>('/virtualization/integrations'), enabled: staff, refetchInterval: 30_000 });
  const mine = (q.data ?? []).filter((i) => i.kind === kind);
  const [nodeId, setNodeId] = useState('');
  const vmsRef = useRef<HTMLDivElement>(null);
  const pickNode = (id: string) => {
    setNodeId(id);
    if (id) vmsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <>
      <PageHeader
        title={NAME[kind]}
        description={
          staff
            ? `Nodes and VMs synced from ${NAME[kind]} with a read-only credential. VM actions run as verified jobs and only where you have granted a separate permission on the hypervisor.`
            : 'Virtual machines assigned to your account.'
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        {staff && (q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : <Integrations kind={kind} list={mine} />)}
        {staff && q.data && <Hosts kind={kind} integrations={mine} nodeId={nodeId} onNode={pickNode} />}
        {(!staff || mine.length > 0) && (
          <div ref={vmsRef} className="scroll-mt-4">
            <Guests kind={kind} integrations={staff ? mine : null} staff={staff} nodeId={nodeId} onNode={setNodeId} />
          </div>
        )}
      </div>
    </>
  );
}

export const ProxmoxPage = () => <VirtualizationPage kind="proxmox" />;
export const VirtualizorPage = () => <VirtualizationPage kind="virtualizor" />;
