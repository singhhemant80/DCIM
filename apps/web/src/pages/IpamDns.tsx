import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DNS_SERVER_KIND_LABELS, DNS_SERVER_KINDS } from '@crapplet/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, Panel, Select, Table, cx } from '../components/ui';

export interface DnsServerT {
  id: string;
  name: string;
  kind: (typeof DNS_SERVER_KINDS)[number];
  url: string | null;
  serverId: string | null;
  verifyTls: boolean;
  secretConfigured: true;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}
export interface DnsZoneT {
  id: string;
  serverId: string;
  serverName: string;
  serverKind: string;
  name: string;
  kind: 'forward' | 'reverse';
  providerZoneId: string | null;
  ttl: number;
  enabled: boolean;
  recordCount: number;
}

/**
 * DNS servers and zones that IPAM publishes A/AAAA/PTR records to. The worker
 * does the pushing; it only creates, changes or deletes records it marked as
 * its own, and leaves records it didn't create alone (reported as a conflict).
 */
export function DnsTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can('dns.manage');
  const servers = useQuery({ queryKey: ['ipam', 'dns', 'servers'], queryFn: () => api.get<DnsServerT[]>('/ipam/dns/servers') });
  const zones = useQuery({ queryKey: ['ipam', 'dns', 'zones'], queryFn: () => api.get<DnsZoneT[]>('/ipam/dns/zones') });
  const [server, setServer] = useState<DnsServerT | 'new' | null>(null);
  const [zone, setZone] = useState<DnsZoneT | 'new' | null>(null);
  const checking = servers.data?.some((s) => s.lastTestMessage === 'Checking…');
  useEffect(() => {
    if (!checking) return;
    const h = setInterval(() => qc.invalidateQueries({ queryKey: ['ipam', 'dns', 'servers'] }), 2000);
    return () => clearInterval(h);
  }, [checking, qc]);
  const test = useMutation({ mutationFn: (id: string) => api.post(`/ipam/dns/servers/${id}/test`), onSuccess: () => qc.invalidateQueries({ queryKey: ['ipam', 'dns'] }) });
  const resync = useMutation({ mutationFn: () => api.post<{ pending: number }>('/ipam/dns/resync') });
  return (
    <div className="grid gap-5">
      <Panel
        flush
        title="DNS servers"
        actions={
          manage && (
            <Button size="sm" variant="primary" onClick={() => setServer('new')}>
              Add server
            </Button>
          )
        }
      >
        <p className="border-b border-rule px-4 py-3 text-[13px] text-ink-2">
          When an address has a DNS name and a matching zone below is enabled, the worker publishes its A/AAAA record and, in a reverse zone, its PTR record. Records DCIM didn't create are never changed or deleted; they show up as a sync error instead. API keys are encrypted and can't be viewed again.
        </p>
        {servers.isLoading && <Loading />}
        <ErrorNote error={servers.error ?? test.error} className="m-4" />
        {servers.data?.length === 0 && <EmptyState title="No DNS servers">Add a PowerDNS server (HTTP API) or a Cloudflare account.</EmptyState>}
        {!!servers.data?.length && (
          <Table label="DNS servers">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Endpoint</th>
                <th>Last check</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {servers.data.map((s) => (
                <tr key={s.id}>
                  <td className="font-medium">{s.name}</td>
                  <td>{DNS_SERVER_KIND_LABELS[s.kind]}</td>
                  <td className="font-mono text-[12.5px]">{s.kind === 'powerdns' ? `${s.url} (${s.serverId})` : 'api.cloudflare.com'}</td>
                  <td className="text-[13px]">
                    {s.lastTestMessage === 'Checking…' ? (
                      <span className="text-ink-3">Checking…</span>
                    ) : s.lastTestAt ? (
                      <span className={s.lastTestOk ? 'text-ok' : 'text-crit'}>
                        {s.lastTestOk ? 'OK' : 'Failed'} {relativeTime(s.lastTestAt)}: {s.lastTestMessage}
                      </span>
                    ) : (
                      <span className="text-ink-3">Not checked</span>
                    )}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {manage && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => test.mutate(s.id)} disabled={checking}>
                          Check
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setServer(s)}>
                          Edit
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <Panel
        flush
        title="Zones"
        actions={
          manage && (
            <div className="flex gap-2">
              <Button size="sm" busy={resync.isPending} onClick={() => resync.mutate()} title="Push every named address again (after adding or enabling a zone)">
                Publish all again
              </Button>
              <Button size="sm" variant="primary" disabled={!servers.data?.length} onClick={() => setZone('new')}>
                Add zone
              </Button>
            </div>
          )
        }
      >
        {resync.data && <p className="border-b border-rule bg-ok-soft px-4 py-2 text-[13px] text-ok">{resync.data.pending} address(es) queued for publishing.</p>}
        <ErrorNote error={zones.error ?? resync.error} className="m-4" />
        {zones.data?.length === 0 && <EmptyState title="No zones">Add the forward zones your hostnames live in (e.g. mum1.example.net) and the reverse zones of your subnets (e.g. 120.150.103.in-addr.arpa). The zones must already exist on the DNS server.</EmptyState>}
        {!!zones.data?.length && (
          <Table label="DNS zones">
            <thead>
              <tr>
                <th>Zone</th>
                <th>Type</th>
                <th>Server</th>
                <th className="text-right">TTL</th>
                <th className="text-right">Records by DCIM</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {zones.data.map((z) => (
                <tr key={z.id}>
                  <td className="font-mono text-[13px]">{z.name}</td>
                  <td>{z.kind === 'forward' ? 'Forward (A/AAAA)' : 'Reverse (PTR)'}</td>
                  <td>{z.serverName}</td>
                  <td className="text-right tabular-nums">{z.ttl}</td>
                  <td className="text-right tabular-nums">{z.recordCount}</td>
                  <td>{z.enabled ? <Chip tone="ok">enabled</Chip> : <Chip>disabled</Chip>}</td>
                  <td className="text-right">
                    {manage && (
                      <Button size="sm" variant="ghost" onClick={() => setZone(z)}>
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      {server && <ServerForm server={server === 'new' ? undefined : server} onClose={() => setServer(null)} />}
      {zone && <ZoneForm zone={zone === 'new' ? undefined : zone} servers={servers.data ?? []} onClose={() => setZone(null)} />}
    </div>
  );
}

function ServerForm({ server, onClose }: { server?: DnsServerT; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ kind: server?.kind ?? 'powerdns', name: server?.name ?? '', url: server?.url ?? '', serverId: server?.serverId ?? 'localhost', verifyTls: server?.verifyTls ?? true, key: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const [confirm, setConfirm] = useState(false);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['ipam', 'dns'] });
    onClose();
  };
  const body = () => (f.kind === 'powerdns' ? { kind: f.kind, name: f.name, url: f.url, serverId: f.serverId || 'localhost', verifyTls: f.verifyTls, apiKey: f.key } : { kind: f.kind, name: f.name, apiToken: f.key });
  const save = useMutation({ mutationFn: () => (server ? api.put(`/ipam/dns/servers/${server.id}`, body()) : api.post('/ipam/dns/servers', body())), onSuccess: done });
  const del = useMutation({ mutationFn: () => api.delete(`/ipam/dns/servers/${server!.id}`), onSuccess: done });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={server ? `Edit ${server.name}` : 'Add DNS server'} description="The key is encrypted and can't be viewed later; enter it again when editing." wide>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Type">
          {(id) => (
            <Select id={id} value={f.kind} disabled={!!server} onChange={set('kind')}>
              {DNS_SERVER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DNS_SERVER_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={set('name')} placeholder={f.kind === 'powerdns' ? 'ns1 (PowerDNS)' : 'Cloudflare'} />}</Field>
        {f.kind === 'powerdns' && (
          <>
            <Field label="API URL" hint="The PowerDNS webserver, e.g. https://ns1.example.net:8081">
              {(id, d) => <Input id={id} aria-describedby={d} type="url" required value={f.url} onChange={set('url')} className="font-mono" />}
            </Field>
            <Field label="Server ID" hint="Usually localhost">
              {(id, d) => <Input id={id} aria-describedby={d} value={f.serverId} onChange={set('serverId')} className="font-mono" />}
            </Field>
            <Field label="API key">{(id) => <Input id={id} type="password" autoComplete="new-password" required value={f.key} onChange={set('key')} />}</Field>
            <label className="flex items-center gap-2 self-end pb-2 text-[13.5px]">
              <input type="checkbox" checked={f.verifyTls} onChange={(e) => setF((x) => ({ ...x, verifyTls: e.target.checked }))} /> Verify the TLS certificate
            </label>
          </>
        )}
        {f.kind === 'cloudflare' && (
          <div className="sm:col-span-2">
            <Field label="API token" hint="A token with Zone → DNS → Edit on the zones DCIM should manage (and Zone → Zone → Read).">
              {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" required value={f.key} onChange={set('key')} />}
            </Field>
          </div>
        )}
        <ErrorNote error={save.error} className="sm:col-span-2" />
        <div className="flex justify-between gap-2 sm:col-span-2">
          <div>
            {server && (
              <Button type="button" variant="ghost" className="text-crit" onClick={() => setConfirm(true)}>
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" busy={save.isPending}>
              Save encrypted
            </Button>
          </div>
        </div>
      </form>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Delete ${server?.name}?`} body="Only possible when it has no zones. Records already published stay on the DNS server." confirmLabel="Delete server" onConfirm={() => del.mutate()} busy={del.isPending} error={del.error} />
    </Modal>
  );
}

function ZoneForm({ zone, servers, onClose }: { zone?: DnsZoneT; servers: DnsServerT[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ serverId: zone?.serverId ?? servers[0]?.id ?? '', name: zone?.name ?? '', kind: zone?.kind ?? 'forward', providerZoneId: zone?.providerZoneId ?? '', ttl: String(zone?.ttl ?? 3600), enabled: zone?.enabled ?? true });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const server = servers.find((s) => s.id === f.serverId);
  const [confirm, setConfirm] = useState(false);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['ipam', 'dns'] });
    onClose();
  };
  const body = () => ({ serverId: f.serverId, name: f.name, kind: f.kind, providerZoneId: f.providerZoneId.trim() || null, ttl: Number(f.ttl), enabled: f.enabled });
  const save = useMutation({ mutationFn: () => (zone ? api.put(`/ipam/dns/zones/${zone.id}`, body()) : api.post('/ipam/dns/zones', body())), onSuccess: done });
  const del = useMutation({ mutationFn: () => api.delete(`/ipam/dns/zones/${zone!.id}`), onSuccess: done });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={zone ? `Edit ${zone.name}` : 'Add zone'} description="The zone must already exist on the DNS server; DCIM only adds records to it." wide>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Zone name" hint={f.kind === 'forward' ? 'e.g. mum1.example.net' : 'e.g. 120.150.103.in-addr.arpa'}>
          {(id, d) => <Input id={id} aria-describedby={d} required value={f.name} onChange={set('name')} className="font-mono" />}
        </Field>
        <Field label="Type">
          {(id) => (
            <Select id={id} value={f.kind} onChange={set('kind')}>
              <option value="forward">Forward (A / AAAA)</option>
              <option value="reverse">Reverse (PTR)</option>
            </Select>
          )}
        </Field>
        <Field label="Server">
          {(id) => (
            <Select id={id} required value={f.serverId} onChange={set('serverId')}>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="TTL (seconds)">{(id) => <Input id={id} type="number" min={60} max={604800} value={f.ttl} onChange={set('ttl')} />}</Field>
        {server?.kind === 'cloudflare' && (
          <Field label="Cloudflare zone ID" hint="Zone overview page → API → Zone ID">
            {(id, d) => <Input id={id} aria-describedby={d} required value={f.providerZoneId} onChange={set('providerZoneId')} className="font-mono" />}
          </Field>
        )}
        <label className={cx('flex items-center gap-2 text-[13.5px]', server?.kind === 'cloudflare' ? 'self-end pb-2' : 'sm:col-span-2')}>
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF((x) => ({ ...x, enabled: e.target.checked }))} /> Enabled (disabled zones keep their records but get no changes)
        </label>
        <ErrorNote error={save.error} className="sm:col-span-2" />
        <div className="flex justify-between gap-2 sm:col-span-2">
          <div>
            {zone && (
              <Button type="button" variant="ghost" className="text-crit" onClick={() => setConfirm(true)}>
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" busy={save.isPending}>
              Save
            </Button>
          </div>
        </div>
      </form>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete zone ${zone?.name}?`}
        body="Refused while DCIM still has records in it. Remove the names from those addresses first, or disable the zone."
        confirmLabel="Delete zone"
        onConfirm={() => del.mutate()}
        busy={del.isPending}
        error={del.error}
      />
    </Modal>
  );
}

/** DNS publication state of one address, shown in the address dialog. */
export function AddressDns({ id, dns, canResync }: { id: string; dns: { status: string; error: string | null; syncedAt: string | null; records: { name: string; type: string; content: string }[] } | undefined; canResync: boolean }) {
  const qc = useQueryClient();
  const resync = useMutation({ mutationFn: () => api.post(`/ipam/dns/addresses/${id}/resync`), onSuccess: () => qc.invalidateQueries({ queryKey: ['ipam'] }) });
  if (!dns || (dns.status === 'none' && !dns.records.length)) return null;
  const tone = dns.status === 'synced' ? 'ok' : dns.status === 'failed' ? 'crit' : 'est';
  return (
    <div className="mt-5">
      <p className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
        DNS <Chip tone={tone}>{dns.status === 'pending' ? 'waiting for the worker' : dns.status}</Chip>
        {dns.syncedAt && <span className="font-normal text-ink-3">published {relativeTime(dns.syncedAt)}</span>}
      </p>
      {dns.error && <p className="text-[12.5px] text-crit">{dns.error}</p>}
      {dns.records.length > 0 && (
        <ul className="font-mono text-[12.5px]">
          {dns.records.map((r) => (
            <li key={`${r.type}${r.name}${r.content}`}>
              {r.name} {r.type} {r.content}
            </li>
          ))}
        </ul>
      )}
      {canResync && dns.status === 'failed' && (
        <Button size="sm" className="mt-2" busy={resync.isPending} onClick={() => resync.mutate()}>
          Try again
        </Button>
      )}
    </div>
  );
}
