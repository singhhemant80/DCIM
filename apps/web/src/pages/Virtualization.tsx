import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { GUEST_ACTIONS, GUEST_ACTION_LABELS, type GuestAction } from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import type { DeviceT } from '../lib/dcim';
import { bytes, duration, newIdempotencyKey, type IntegrationT, type JobT, type VirtGuestT, type VirtHostT } from '../lib/provisioning';
import { JobModal } from '../components/Jobs';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Panel, Select, Table } from '../components/ui';

type Kind = 'proxmox' | 'virtualizor';
const NAME: Record<Kind, string> = { proxmox: 'Proxmox VE', virtualizor: 'Virtualizor' };
interface Customer {
  id: string;
  name: string;
  code: string;
}

const statusTone = (s: string | null) => (s === 'running' || s === 'online' ? 'ok' : s === 'stopped' || s === 'offline' ? 'neutral' : s === 'suspended' ? 'warn' : 'neutral');

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
                  {i.lastError && <div className="mt-1 max-w-[40ch] truncate text-[12px] text-crit" title={i.lastError}>{i.lastError}</div>}
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

function Hosts({ kind, integrations }: { kind: Kind; integrations: IntegrationT[] }) {
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
              <tr key={h.id} className={h.missingSince ? 'opacity-60' : ''}>
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
                <td>{h.guests}</td>
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

function Guests({ kind, integrations, staff }: { kind: Kind; integrations: IntegrationT[] | null; staff: boolean }) {
  const { can } = useAuth();
  const canControl = can('hardware.control');
  const canAssign = staff && can('provisioning.execute');
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [integrationId, setIntegrationId] = useState('');
  const [act, setAct] = useState<VirtGuestT | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['virt', 'guests', kind, integrationId, search, page],
    queryFn: () => api.get<Paginated<VirtGuestT>>(`/virtualization/guests${qs({ kind, integrationId: integrationId || undefined, q: search.trim() || undefined, page, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.items.some((g) => g.activeJob) ? 4000 : 60_000),
  });
  const customers = useQuery({ queryKey: ['customers', 'options'], queryFn: () => api.get<Paginated<Customer>>('/customers?pageSize=200'), enabled: canAssign });
  const assign = useMutation({ mutationFn: (v: { id: string; customerId: string | null }) => api.put(`/virtualization/guests/${v.id}/customer`, { customerId: v.customerId }), onSuccess: () => qc.invalidateQueries({ queryKey: ['virt', 'guests'] }) });
  const items = q.data?.items ?? [];
  return (
    <Panel
      flush
      title={staff ? 'Virtual machines' : 'Your virtual machines'}
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
          <Input className="w-48" aria-label="Search" placeholder="Name, ID or IP" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
        </div>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorNote error={q.error} className="m-4" />
      ) : !items.length ? (
        <EmptyState title="No virtual machines">{staff ? 'VMs appear after the first sync.' : 'No VMs have been assigned to your account.'}</EmptyState>
      ) : (
        <Table label="Virtual machines">
          <thead>
            <tr>
              <th>VM</th>
              <th>Status</th>
              <th>Resources</th>
              <th>Addresses</th>
              {staff && <th>Customer</th>}
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
                </td>
                <td>
                  {g.missingSince ? (
                    <Chip tone="warn" title="No longer reported by the hypervisor; kept with its assignment">
                      Missing since {relativeTime(g.missingSince)}
                    </Chip>
                  ) : (
                    <Chip tone={statusTone(g.status)}>{g.status ?? 'unknown'}</Chip>
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
                        <option value="">Unassigned</option>
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
                <td className="text-right">
                  {canControl && g.actionsEnabled && !g.missingSince && (
                    <Button size="sm" variant="ghost" disabled={!!g.activeJob} onClick={() => setAct(g)}>
                      Actions
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
        {staff && q.data && <Hosts kind={kind} integrations={mine} />}
        {(!staff || mine.length > 0) && <Guests kind={kind} integrations={staff ? mine : null} staff={staff} />}
      </div>
    </>
  );
}

export const ProxmoxPage = () => <VirtualizationPage kind="proxmox" />;
export const VirtualizorPage = () => <VirtualizationPage kind="virtualizor" />;
