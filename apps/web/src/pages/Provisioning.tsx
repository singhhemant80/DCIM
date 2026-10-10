import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { INSTALL_METHOD_LABELS, JOB_KINDS, OS_FAMILIES, TEMPLATE_KIND_LABELS, TEMPLATE_KINDS, type InstallMethod, type JobKind } from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, relativeTime } from '../lib/format';
import type { DeviceT } from '../lib/dcim';
import { bytes, isActive, jobKindLabel, newIdempotencyKey, type JobT, type OsImageT } from '../lib/provisioning';
import { JobModal, JobStatusChip } from '../components/Jobs';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Panel, Select, Stat, Table, Textarea } from '../components/ui';
import { Tabs } from './Network';

/* ================================================================== jobs */

const describe = (j: JobT) => {
  const p = j.params as Record<string, string>;
  if (j.kind === 'power_action') return String(p.action ?? '').replace(/_/g, ' ');
  if (j.kind === 'os_install') return `${p.imageName ?? j.imageName ?? 'image'} as ${p.hostname ?? '?'} (${p.method === 'pxe' ? 'PXE' : 'virtual media'})`;
  if (j.kind === 'guest_action') return String(p.action ?? '');
  return 'checksum verification';
};

function JobsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const [status, setStatus] = useState<'all' | 'active' | 'finished'>('all');
  const [kind, setKind] = useState<JobKind | ''>('');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['provisioning', 'jobs', status, kind, page],
    queryFn: () => api.get<Paginated<JobT>>(`/provisioning/jobs${qs({ status, kind, page, pageSize: 25 })}`),
    refetchInterval: (query) => (query.state.data?.items.some((j) => isActive(j.status)) ? 4000 : 30_000),
    placeholderData: keepPreviousData,
  });
  return (
    <Panel
      flush
      title="Jobs"
      actions={
        <div className="flex gap-2">
          <Select className="w-28 sm:w-36" aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value as typeof status), setPage(1))}>
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="finished">Finished</option>
          </Select>
          <Select className="w-36 sm:w-44" aria-label="Kind" value={kind} onChange={(e) => (setKind(e.target.value as JobKind | ''), setPage(1))}>
            <option value="">Every kind</option>
            {JOB_KINDS.map((k) => (
              <option key={k} value={k}>
                {jobKindLabel(k)}
              </option>
            ))}
          </Select>
        </div>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorNote error={q.error} className="m-4" />
      ) : !q.data!.items.length ? (
        <EmptyState title="No jobs">Power actions, OS installations, image checks and VM actions appear here with every step they ran.</EmptyState>
      ) : (
        <>
          <Table label="Provisioning jobs">
            <thead>
              <tr>
                <th>Status</th>
                <th>Job</th>
                <th>Target</th>
                <th>Progress</th>
                <th>Requested</th>
              </tr>
            </thead>
            <tbody>
              {q.data!.items.map((j) => (
                <tr key={j.id} className="cursor-pointer hover:bg-sunken/60" onClick={() => onOpen(j.id)}>
                  <td>
                    <JobStatusChip status={j.status} cancelRequested={j.cancelRequested} verified={j.verified} />
                  </td>
                  <td>
                    <div className="font-medium">{jobKindLabel(j.kind)}</div>
                    <div className="text-[12.5px] text-ink-3">{describe(j)}</div>
                  </td>
                  <td>
                    {j.deviceId ? (
                      <Link className="text-accent hover:underline" to={`/hardware/${j.deviceId}`} onClick={(e) => e.stopPropagation()}>
                        {j.deviceName}
                      </Link>
                    ) : (
                      (j.guestName ?? j.imageName ?? '—')
                    )}
                  </td>
                  <td className="text-[13px]">
                    {j.stepCount ? `${Math.min(j.currentStep, j.stepCount)} / ${j.stepCount} steps` : '—'}
                    {j.error && <div className="max-w-[48ch] truncate text-crit" title={j.error}>{j.error}</div>}
                  </td>
                  <td className="text-[13px] text-ink-2">
                    {j.createdBy}
                    <div className="text-ink-3">{relativeTime(j.createdAt)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={q.data!.page} pageSize={q.data!.pageSize} total={q.data!.total} onPage={setPage} />
        </>
      )}
    </Panel>
  );
}

/* ================================================================== install wizard */

function InstallForm({ initialDevice, onQueued }: { initialDevice: string | null; onQueued: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const devices = useQuery({
    queryKey: ['dcim', 'devices', 'servers', search],
    queryFn: () => api.get<Paginated<DeviceT>>(`/dcim/devices${qs({ q: search.trim() || undefined, category: 'server', pageSize: 50 })}`),
    placeholderData: keepPreviousData,
  });
  const images = useQuery({ queryKey: ['provisioning', 'images'], queryFn: () => api.get<OsImageT[]>('/provisioning/images') });
  const usable = (images.data ?? []).filter((i) => i.enabled && i.verifyStatus === 'verified');
  const [deviceId, setDeviceId] = useState(initialDevice ?? '');
  const [imageId, setImageId] = useState('');
  const [method, setMethod] = useState<InstallMethod>('redfish_virtual_media');
  const [hostname, setHostname] = useState('');
  const [mac, setMac] = useState('');
  const [netMode, setNetMode] = useState<'dhcp' | 'static'>('dhcp');
  const [address, setAddress] = useState('');
  const [prefix, setPrefix] = useState('24');
  const [gateway, setGateway] = useState('');
  const [dns, setDns] = useState('');
  const [rootPassword, setRootPassword] = useState('');
  const [sshKeys, setSshKeys] = useState('');
  const [verifyBy, setVerifyBy] = useState<'callback' | 'tcp'>('callback');
  const [verifyPort, setVerifyPort] = useState('22');
  const [timeout, setTimeoutMin] = useState('120');
  const [confirm, setConfirm] = useState('');
  const [wipe, setWipe] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const control = useQuery({ queryKey: ['provisioning', 'control', deviceId], queryFn: () => api.get<{ configured: boolean; credential: { kind: string } | null; name: string }>(`/provisioning/devices/${deviceId}/control`), enabled: !!deviceId });
  const device = devices.data?.items.find((d) => d.id === deviceId);
  const image = usable.find((i) => i.id === imageId);
  const deviceName = control.data?.name ?? device?.hostname ?? device?.assetTag ?? '';
  const m = useMutation({
    mutationFn: () =>
      api.post<JobT>(
        '/provisioning/installs',
        {
          deviceId,
          imageId,
          method,
          hostname,
          macAddress: mac.trim() || null,
          network: netMode === 'dhcp' ? { mode: 'dhcp' } : { mode: 'static', address: address.trim(), prefixLength: Number(prefix), gateway: gateway.trim() || null, nameservers: dns.split(/[\s,]+/).filter(Boolean) },
          rootPassword: rootPassword || null,
          sshKeys: sshKeys.split('\n').map((s) => s.trim()).filter(Boolean),
          verify: verifyBy === 'tcp' ? { by: 'tcp', port: Number(verifyPort) } : { by: 'callback' },
          timeoutMinutes: Number(timeout),
          confirm,
          wipeAcknowledged: wipe,
        },
        { 'Idempotency-Key': key },
      ),
    onSuccess: (j) => onQueued(j.id),
  });
  const methodOk = !image || (method === 'pxe' ? !!image.kernelUrl : !!image.isoUrl);
  const credOk = control.data?.configured && (method === 'pxe' || control.data.credential?.kind !== 'ipmi');
  return (
    <form
      className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Panel title="1 · Server and image">
        <div className="flex flex-col gap-3">
          <Field label="Find a server" hint="Search by asset tag, host name or serial">
            {(id) => <Input id={id} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="SRV-01" />}
          </Field>
          <Field label="Server">
            {(id) => (
              <Select id={id} value={deviceId} onChange={(e) => setDeviceId(e.target.value)} required>
                <option value="">Choose…</option>
                {deviceId && !device && <option value={deviceId}>{deviceName || 'Selected server'}</option>}
                {devices.data?.items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.assetTag}
                    {d.hostname ? ` · ${d.hostname}` : ''}
                    {d.customerName ? ` · ${d.customerName}` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {deviceId && control.data && !control.data.configured && (
            <p className="rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
              No BMC control account for this server. Set it up on the <Link className="underline" to={`/hardware/${deviceId}`}>server’s page</Link> first.
            </p>
          )}
          <Field label="Image" hint={images.data && !usable.length ? 'No verified image yet: add one under OS & Images and verify its checksums.' : 'Only enabled images with verified checksums are listed.'}>
            {(id) => (
              <Select id={id} value={imageId} onChange={(e) => setImageId(e.target.value)} required>
                <option value="">Choose…</option>
                {usable.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                    {i.templateKind !== 'none' ? ` · ${i.templateKind}` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Boot method" error={!methodOk ? (method === 'pxe' ? 'This image has no kernel and initrd' : 'This image has no ISO') : deviceId && control.data?.configured && !credOk ? 'Virtual media needs a Redfish control account' : undefined}>
            {(id) => (
              <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as InstallMethod)}>
                {(['redfish_virtual_media', 'pxe'] as const).map((x) => (
                  <option key={x} value={x}>
                    {INSTALL_METHOD_LABELS[x]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={method === 'pxe' ? 'MAC address of the boot NIC' : 'MAC address (optional)'} hint={method === 'pxe' ? 'The iPXE script is matched to the server by this MAC.' : 'Lets an ISO remastered to fetch /api/v1/boot/config?mac=… find its configuration.'}>
            {(id) => <Input id={id} value={mac} onChange={(e) => setMac(e.target.value)} placeholder="52:54:00:12:34:56" required={method === 'pxe'} />}
          </Field>
        </div>
      </Panel>
      <Panel title="2 · New system">
        <div className="flex flex-col gap-3">
          <Field label="Host name (FQDN)">{(id) => <Input id={id} value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="web-01.example.net" required />}</Field>
          <Field label="Network">
            {(id) => (
              <Select id={id} value={netMode} onChange={(e) => setNetMode(e.target.value as 'dhcp' | 'static')}>
                <option value="dhcp">DHCP</option>
                <option value="static">Static address</option>
              </Select>
            )}
          </Field>
          {netMode === 'static' && (
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3">
              <Field label="Address" hint="Must not be assigned to something else in IPAM">{(id) => <Input id={id} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="203.0.113.10" required />}</Field>
              <Field label="Prefix length">{(id) => <Input id={id} inputMode="numeric" value={prefix} onChange={(e) => setPrefix(e.target.value.replace(/\D/g, ''))} required />}</Field>
              <Field label="Gateway">{(id) => <Input id={id} value={gateway} onChange={(e) => setGateway(e.target.value)} />}</Field>
              <Field label="DNS servers">{(id) => <Input id={id} value={dns} onChange={(e) => setDns(e.target.value)} placeholder="1.1.1.1 9.9.9.9" />}</Field>
            </div>
          )}
          <Field label="Root password" hint="At least 12 characters. Stored only as a SHA-512 crypt hash for the installer; never shown again.">
            {(id) => <Input id={id} type="password" autoComplete="new-password" value={rootPassword} onChange={(e) => setRootPassword(e.target.value)} minLength={12} />}
          </Field>
          <Field label="SSH public keys" hint="One per line">
            {(id) => <Textarea id={id} rows={3} className="font-mono text-[12px]" value={sshKeys} onChange={(e) => setSshKeys(e.target.value)} placeholder="ssh-ed25519 AAAA… you@example" />}
          </Field>
        </div>
      </Panel>
      <Panel title="3 · Verification">
        <div className="flex flex-col gap-3">
          <Field label="Success is confirmed by" hint={verifyBy === 'callback' ? 'The template must POST {"status":"done"} to {{callbackUrl}} at the end of the install.' : 'The installed system must answer on this TCP port at the static address. An answer counts only after the port was seen closed (the previous system may answer until the installer takes over); the callback is the stronger check.'}>
            {(id) => (
              <Select id={id} value={verifyBy} onChange={(e) => setVerifyBy(e.target.value as 'callback' | 'tcp')}>
                <option value="callback">Installer callback</option>
                <option value="tcp" disabled={netMode !== 'static'}>
                  TCP port on the new system{netMode !== 'static' ? ' (needs a static address)' : ''}
                </option>
              </Select>
            )}
          </Field>
          {verifyBy === 'tcp' && <Field label="Port">{(id) => <Input id={id} inputMode="numeric" value={verifyPort} onChange={(e) => setVerifyPort(e.target.value.replace(/\D/g, ''))} />}</Field>}
          <Field label="Give up after (minutes)">{(id) => <Input id={id} inputMode="numeric" value={timeout} onChange={(e) => setTimeoutMin(e.target.value.replace(/\D/g, ''))} />}</Field>
          <p className="text-[12.5px] text-ink-3">The job completes only after the installer (or the TCP check) confirms it, the server is on, the one-time boot override is gone and the ISO is ejected. Inventory (host name, OS) is updated after that.</p>
        </div>
      </Panel>
      <Panel title="4 · Confirm">
        <div className="flex flex-col gap-3">
          <p className="rounded-md border border-crit/30 bg-crit-soft px-3 py-2 text-[13px] text-crit">Installing erases the disks of {deviceName || 'the selected server'}. The server is restarted if it is running.</p>
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={wipe} onChange={(e) => setWipe(e.target.checked)} /> I understand that every disk in this server will be erased.
          </label>
          <Field label={`Type ${deviceName || 'the server’s name'} to confirm`}>{(id) => <Input id={id} autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
          <ErrorNote error={m.error} />
          <div className="flex justify-end">
            <Button type="submit" variant="danger" busy={m.isPending} disabled={!deviceId || !imageId || !wipe || !methodOk || !credOk || !deviceName || confirm.trim().toLowerCase() !== deviceName.toLowerCase()}>
              Erase and install
            </Button>
          </div>
        </div>
      </Panel>
    </form>
  );
}

function Summary() {
  const q = useQuery({ queryKey: ['provisioning', 'summary'], queryFn: () => api.get<{ active: number; recovery: number; completed7d: number; unverified7d: number; failed7d: number }>('/provisioning/summary'), refetchInterval: 15_000 });
  if (!q.data) return null;
  return (
    <Panel className="mb-5">
      <dl className="grid grid-cols-2 gap-5 sm:grid-cols-4">
        <Stat label="Active jobs" value={q.data.active} />
        <Stat label="Need a decision" value={q.data.recovery} tone={q.data.recovery ? 'warn' : undefined} note={q.data.recovery ? 'Interrupted in a step that is not safe to repeat' : undefined} />
        <Stat label="Completed, 7 days" value={q.data.completed7d} tone="ok" note={q.data.unverified7d ? `plus ${q.data.unverified7d} not verified` : 'All verified'} />
        <Stat label="Failed, 7 days" value={q.data.failed7d} tone={q.data.failed7d ? 'crit' : undefined} />
      </dl>
    </Panel>
  );
}

export function ProvisioningPage() {
  const { can, me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const canExecute = staff && can('provisioning.execute');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'install' && canExecute ? 'install' : 'jobs';
  const [job, setJob] = useState<string | null>(params.get('job'));
  const qc = useQueryClient();
  const tabs = canExecute
    ? ([
        { key: 'jobs', label: 'Jobs' },
        { key: 'install', label: 'Install an OS' },
      ] as const)
    : ([{ key: 'jobs', label: 'Jobs' }] as const);
  return (
    <>
      <PageHeader
        title="Server provisioning"
        description="Every power action, installation and VM action runs as a job of recorded steps. A job is completed only after its result is checked; where the equipment can't show the result (for example a restart on a BMC that doesn't report boots) it is marked “not verified”. A job interrupted in a step that is not safe to repeat waits for an operator."
      />
      {staff && <Summary />}
      <Tabs tabs={tabs} value={tab} onChange={(k) => setParams(k === 'jobs' ? {} : { tab: k })} label="Provisioning" />
      {tab === 'jobs' ? (
        <JobsTab onOpen={setJob} />
      ) : (
        <InstallForm
          initialDevice={params.get('device')}
          onQueued={(id) => {
            void qc.invalidateQueries({ queryKey: ['provisioning'] });
            setParams({});
            setJob(id);
          }}
        />
      )}
      <JobModal id={job} onClose={() => setJob(null)} />
    </>
  );
}

/* ================================================================== images */

const VARS = ['hostname', 'shortname', 'domain', 'networkMode', 'static', 'dhcp', 'ip', 'prefix', 'netmask', 'gateway', 'nameservers', 'nameserversCsv', 'mac', 'rootPasswordHash', 'sshKeys', 'sshKeysJson', 'callbackUrl', 'configUrl', 'jobId', 'imageName'];

const VERIFY_TONE: Record<OsImageT['verifyStatus'], 'ok' | 'warn' | 'crit' | 'accent' | 'neutral'> = { verified: 'ok', unverified: 'warn', verifying: 'accent', mismatch: 'crit', error: 'crit' };
const VERIFY_LABEL: Record<OsImageT['verifyStatus'], string> = { verified: 'Checksums verified', unverified: 'Not verified', verifying: 'Verifying…', mismatch: 'Checksum mismatch', error: 'Verification failed' };

function ImageDialog({ image, open, onClose }: { image: OsImageT | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(() => ({
    name: image?.name ?? '',
    family: image?.family ?? 'rhel',
    version: image?.version ?? '',
    arch: image?.arch ?? 'x86_64',
    isoUrl: image?.isoUrl ?? '',
    isoSha256: image?.isoSha256 ?? '',
    kernelUrl: image?.kernelUrl ?? '',
    kernelSha256: image?.kernelSha256 ?? '',
    initrdUrl: image?.initrdUrl ?? '',
    initrdSha256: image?.initrdSha256 ?? '',
    bootArgs: image?.bootArgs ?? '',
    templateKind: image?.templateKind ?? 'none',
    template: image?.template ?? '',
    enabled: image?.enabled ?? true,
    notes: image?.notes ?? '',
  }));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const n = (v: string) => v.trim() || null;
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...f,
        version: n(f.version),
        isoUrl: n(f.isoUrl),
        isoSha256: n(f.isoSha256)?.toLowerCase() ?? null,
        kernelUrl: n(f.kernelUrl),
        kernelSha256: n(f.kernelSha256)?.toLowerCase() ?? null,
        initrdUrl: n(f.initrdUrl),
        initrdSha256: n(f.initrdSha256)?.toLowerCase() ?? null,
        bootArgs: n(f.bootArgs),
        template: f.templateKind === 'none' ? null : f.template,
        notes: n(f.notes),
      };
      return image ? api.put(`/provisioning/images/${image.id}`, body) : api.post('/provisioning/images', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['provisioning', 'images'] });
      onClose();
    },
  });
  const file = (label: string, url: 'isoUrl' | 'kernelUrl' | 'initrdUrl', sum: 'isoSha256' | 'kernelSha256' | 'initrdSha256') => (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Field label={`${label} URL`}>{(id) => <Input id={id} value={f[url]} onChange={set(url)} placeholder="https://mirror.example.net/…" />}</Field>
      <Field label="SHA-256">{(id) => <Input id={id} className="font-mono text-[12px]" value={f[sum]} onChange={set(sum)} />}</Field>
    </div>
  );
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={image ? `Edit ${image.name}` : 'Add an image'} description="Files are fetched by the BMC or the installing server; DCIM downloads them once to check their SHA-256. Changing a file or checksum requires a new verification." wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="col-span-2">
            <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={set('name')} required placeholder="AlmaLinux 9.4" />}</Field>
          </div>
          <Field label="Family">
            {(id) => (
              <Select id={id} value={f.family} onChange={set('family')}>
                {OS_FAMILIES.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Version">{(id) => <Input id={id} value={f.version} onChange={set('version')} />}</Field>
        </div>
        <p className="text-[13px] font-semibold text-ink-2">Virtual media</p>
        {file('ISO', 'isoUrl', 'isoSha256')}
        <p className="text-[13px] font-semibold text-ink-2">Network boot (PXE / iPXE)</p>
        {file('Kernel', 'kernelUrl', 'kernelSha256')}
        {file('Initrd', 'initrdUrl', 'initrdSha256')}
        <Field label="Kernel arguments" hint="For example: inst.ks={{configUrl}} ip=dhcp (RHEL) or autoinstall ds=nocloud-net;s={{configUrl}}/ (Ubuntu)">
          {(id) => <Input id={id} className="font-mono text-[12px]" value={f.bootArgs} onChange={set('bootArgs')} />}
        </Field>
        <Field label="Unattended install">
          {(id) => (
            <Select id={id} value={f.templateKind} onChange={set('templateKind')}>
              {TEMPLATE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TEMPLATE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {f.templateKind !== 'none' && (
          <Field label="Template" hint={<>Variables: {VARS.map((v) => <code key={v} className="mr-1">{`{{${v}}}`}</code>)} and <code>{'{{#if static}}…{{/if}}'}</code>. Unknown variables are rejected.</>}>
            {(id) => <Textarea id={id} rows={12} className="font-mono text-[12px]" value={f.template} onChange={set('template')} />}
          </Field>
        )}
        <Field label="Notes">{(id) => <Input id={id} value={f.notes} onChange={set('notes')} />}</Field>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF((x) => ({ ...x, enabled: e.target.checked }))} /> Available for new installations
        </label>
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

export function ImagesPage() {
  const { can } = useAuth();
  const canExecute = can('provisioning.execute');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['provisioning', 'images'],
    queryFn: () => api.get<OsImageT[]>('/provisioning/images'),
    refetchInterval: (query) => (query.state.data?.some((i) => i.verifyStatus === 'verifying') ? 4000 : false),
  });
  const [edit, setEdit] = useState<OsImageT | null | 'new'>(null);
  const [job, setJob] = useState<string | null>(null);
  const verify = useMutation({
    mutationFn: (id: string) => api.post<JobT>(`/provisioning/images/${id}/verify`, {}, { 'Idempotency-Key': newIdempotencyKey() }),
    onSuccess: (j) => {
      void qc.invalidateQueries({ queryKey: ['provisioning'] });
      setJob(j.id);
    },
  });
  const [deleting, setDeleting] = useState<OsImageT | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/provisioning/images/${id}`),
    onSuccess: () => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['provisioning', 'images'] });
    },
  });
  return (
    <>
      <PageHeader
        title="OS & images"
        description="Installation media with their SHA-256 checksums and unattended-install templates. An image can be installed only after DCIM has downloaded every file and matched its checksum."
        actions={
          canExecute && (
            <Button variant="primary" onClick={() => setEdit('new')}>
              Add image
            </Button>
          )
        }
      />
      <Panel flush>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorNote error={q.error} className="m-4" />
        ) : !q.data!.length ? (
          <EmptyState title="No images yet">Add an ISO for Redfish virtual media, or a kernel and initrd for PXE, with the checksums published by the distribution.</EmptyState>
        ) : (
          <Table label="Images">
            <thead>
              <tr>
                <th>Image</th>
                <th>Boot</th>
                <th>Template</th>
                <th>Checksums</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data!.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div className="font-medium">
                      {i.name} {!i.enabled && <Chip>Disabled</Chip>}
                    </div>
                    <div className="text-[12.5px] text-ink-3">
                      {i.family}
                      {i.version ? ` ${i.version}` : ''} · {i.arch}
                    </div>
                  </td>
                  <td className="text-[13px]">
                    {i.isoUrl && <div>ISO {i.sizes.ISO ? `(${bytes(i.sizes.ISO)})` : ''}</div>}
                    {i.kernelUrl && <div>PXE kernel + initrd</div>}
                  </td>
                  <td className="text-[13px]">{i.templateKind === 'none' ? '—' : TEMPLATE_KIND_LABELS[i.templateKind]}</td>
                  <td>
                    <Chip tone={VERIFY_TONE[i.verifyStatus]} title={i.verifyError ?? (i.verifiedAt ? `Verified ${formatDateTime(i.verifiedAt)}` : undefined)}>
                      {VERIFY_LABEL[i.verifyStatus]}
                    </Chip>
                    {i.verifyError && <div className="mt-1 max-w-[40ch] truncate text-[12px] text-crit" title={i.verifyError}>{i.verifyError}</div>}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {canExecute && (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" disabled={i.verifyStatus === 'verifying'} busy={verify.isPending && verify.variables === i.id} onClick={() => verify.mutate(i.id)}>
                          Verify
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEdit(i)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" className="text-crit" onClick={() => (remove.reset(), setDeleting(i))}>
                          Delete
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <ErrorNote error={verify.error} className="m-4" />
      </Panel>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ''}?`}
        body="The image is removed from the library. Past jobs keep their record. Files on the mirror are not touched."
        confirmLabel="Delete image"
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
      {edit && <ImageDialog key={edit === 'new' ? 'new' : edit.id} image={edit === 'new' ? null : edit} open onClose={() => setEdit(null)} />}
      <JobModal id={job} onClose={() => setJob(null)} />
    </>
  );
}

