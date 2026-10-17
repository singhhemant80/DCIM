import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PXE_MODE_LABELS, PXE_MODES, type PxeMode } from '@crapplet/shared';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import type { PxeViewT } from '../lib/provisioning';
import { Button, Chip, ErrorNote, Field, Input, Loading, Panel, Select } from './ui';

type Range = { network: string; start: string; end: string; gateway: string; dns: string };
const list = (v: string) =>
  v
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Commands and checks for the chosen mode; nothing on the router is ever changed by NexoraDC. */
function ModeHelp({ mode, server, ranges }: { mode: PxeMode; server: string; ranges: Range[] }) {
  const s = server || '<NexoraDC address>';
  const code = (t: string) => <pre className="mt-1 overflow-x-auto rounded-md bg-sunken p-2 font-mono text-[12px] whitespace-pre-wrap">{t}</pre>;
  if (mode === 'proxy')
    return (
      <div className="text-[13px] text-ink-2">
        <p>
          Nothing to change on your router or DHCP server. NexoraDC must be on the same network (VLAN) as the servers’ boot NICs: it listens for their PXE requests and adds the boot file to the address your DHCP server gives. It answers
          only servers that have an install running.
        </p>
      </div>
    );
  if (mode === 'dhcp')
    return (
      <div className="flex flex-col gap-2 text-[13px] text-ink-2">
        <p>
          NexoraDC hands out addresses from the ranges below, only to servers with an install running (every other device is ignored). If the servers are on another network than NexoraDC, forward their DHCP to NexoraDC with a DHCP relay on
          the router, for example on MikroTik:
        </p>
        {code(
          ranges.length
            ? ranges.map((r) => `/ip dhcp-relay add name=nexora-pxe interface=<interface of ${r.network || 'the server network'}> dhcp-server=${s} local-address=${r.gateway || '<router address on that network>'} disabled=no`).join('\n')
            : `/ip dhcp-relay add name=nexora-pxe interface=<server VLAN interface> dhcp-server=${s} local-address=<router address on that VLAN> disabled=no`,
        )}
        <p>A network served by a relay should not also have the router’s own DHCP server; otherwise use “Your DHCP server points to NexoraDC”.</p>
      </div>
    );
  return (
    <div className="flex flex-col gap-2 text-[13px] text-ink-2">
      <p>
        Your DHCP server keeps giving addresses and points network-booting servers to NexoraDC: next server {s}, boot file <code>undionly.kpxe</code> (legacy BIOS) or <code>snponly.efi</code> (UEFI). On MikroTik, for the server network:
      </p>
      {code(`/ip dhcp-server network set [find address="<server network, e.g. 163.52.252.0/24>"] next-server=${s} boot-file-name=undionly.kpxe`)}
      <p>
        For servers that boot in UEFI mode the boot file must be <code>snponly.efi</code>; DHCP servers choose it by the client architecture (option 93 = 7 or 9). Servers that are not being installed get “no install” from NexoraDC and
        continue with their next boot device.
      </p>
    </div>
  );
}

export function PxeSettingsPanel({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['provisioning', 'pxe'], queryFn: () => api.get<PxeViewT>('/provisioning/pxe'), refetchInterval: 10_000 });
  const [f, setF] = useState<{ enabled: boolean; mode: PxeMode; iface: string; server: string; proxy: string; ranges: Range[]; boot: string; allow: string } | null>(null);
  useEffect(() => {
    if (!q.data || f) return;
    const s = q.data.settings;
    const firstIp = q.data.interfaces[0]?.addresses[0]?.split('/')[0] ?? '';
    setF({
      enabled: s?.enabled ?? false,
      mode: (s?.mode as PxeMode) ?? 'proxy',
      iface: s?.interface ?? '',
      server: s?.serverAddress ?? firstIp,
      proxy: (s?.proxyNetworks ?? []).join(', '),
      ranges: (s?.ranges ?? []).map((r) => ({ network: r.network, start: r.start, end: r.end, gateway: r.gateway ?? '', dns: r.dns.join(' ') })),
      boot: s?.bootBaseUrl ?? '',
      allow: (s?.allowNetworks ?? []).join(', '),
    });
  }, [q.data, f]);
  const save = useMutation({
    mutationFn: () =>
      api.put('/provisioning/pxe', {
        enabled: f!.enabled,
        mode: f!.mode,
        interface: f!.iface.trim() || null,
        serverAddress: f!.server.trim(),
        proxyNetworks: list(f!.proxy),
        ranges: f!.ranges.map((r) => ({ network: r.network.trim(), start: r.start.trim(), end: r.end.trim(), gateway: r.gateway.trim() || null, dns: list(r.dns) })),
        bootBaseUrl: f!.boot.trim() || null,
        allowNetworks: list(f!.allow),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['provisioning', 'pxe'] }),
  });
  if (q.isLoading || !f) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const s = q.data!.settings;
  const status = !s?.enabled ? (
    <Chip>Off</Chip>
  ) : s.applyError ? (
    <Chip tone="crit" title={s.applyError}>
      Problem
    </Chip>
  ) : s.appliedAt ? (
    <Chip tone="ok">Running · applied {relativeTime(s.appliedAt)}</Chip>
  ) : (
    <Chip tone="accent">Applying…</Chip>
  );
  const set = <K extends keyof NonNullable<typeof f>>(k: K, v: NonNullable<typeof f>[K]) => setF((x) => (x ? { ...x, [k]: v } : x));
  const setRange = (i: number, k: keyof Range, v: string) =>
    set(
      'ranges',
      f.ranges.map((r, j) => (j === i ? { ...r, [k]: v } : r)),
    );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Panel title="PXE service" actions={status}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <p className="text-[13px] text-ink-2">
            Network boot for OS installs: NexoraDC runs a small DHCP/TFTP service (dnsmasq) that hands servers the NexoraDC network boot loader (iPXE). It answers only servers with an install running, so other devices on the network are
            never affected.
          </p>
          {s?.applyError && <p className="rounded-md bg-crit-soft px-3 py-2 text-[13px] text-crit">{s.applyError}</p>}
          <label className="flex items-center gap-2 text-[13px] font-medium">
            <input type="checkbox" checked={f.enabled} disabled={!canEdit} onChange={(e) => set('enabled', e.target.checked)} /> PXE service on
          </label>
          <Field label="How servers get their address">
            {(id) => (
              <Select id={id} value={f.mode} disabled={!canEdit} onChange={(e) => set('mode', e.target.value as PxeMode)}>
                {PXE_MODES.map((m) => (
                  <option key={m} value={m}>
                    {PXE_MODE_LABELS[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Field label="Network interface" hint="Where the service listens (empty: every interface)">
              {(id) => (
                <Select
                  id={id}
                  value={f.iface}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const nic = q.data!.interfaces.find((n) => n.name === e.target.value);
                    setF((x) => (x ? { ...x, iface: e.target.value, server: nic?.addresses[0]?.split('/')[0] ?? x.server } : x));
                  }}
                >
                  <option value="">Every interface</option>
                  {q.data!.interfaces.map((n) => (
                    <option key={n.name} value={n.name}>
                      {n.name} · {n.addresses.join(', ')}
                    </option>
                  ))}
                  {f.iface && !q.data!.interfaces.some((n) => n.name === f.iface) && <option value={f.iface}>{f.iface}</option>}
                </Select>
              )}
            </Field>
            <Field label="This server’s address" hint="As the booting servers reach NexoraDC (TFTP next server)">
              {(id) => <Input id={id} value={f.server} disabled={!canEdit} onChange={(e) => set('server', e.target.value)} placeholder="163.52.252.10" required />}
            </Field>
          </div>
          {f.mode === 'proxy' && (
            <Field label="Server networks" hint="Where your DHCP server gives the servers their addresses, e.g. 163.52.252.0/24 (comma-separated)">
              {(id) => <Input id={id} value={f.proxy} disabled={!canEdit} onChange={(e) => set('proxy', e.target.value)} placeholder="163.52.252.0/24" />}
            </Field>
          )}
          {f.mode === 'dhcp' && (
            <div className="flex flex-col gap-2">
              <p className="text-[13px] font-semibold text-ink-2">Address ranges for servers being installed</p>
              {f.ranges.map((r, i) => (
                <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-rule p-2 sm:grid-cols-3">
                  <Field label="Network">{(id) => <Input id={id} value={r.network} disabled={!canEdit} onChange={(e) => setRange(i, 'network', e.target.value)} placeholder="163.52.252.0/24" />}</Field>
                  <Field label="First address">{(id) => <Input id={id} value={r.start} disabled={!canEdit} onChange={(e) => setRange(i, 'start', e.target.value)} placeholder="163.52.252.200" />}</Field>
                  <Field label="Last address">{(id) => <Input id={id} value={r.end} disabled={!canEdit} onChange={(e) => setRange(i, 'end', e.target.value)} placeholder="163.52.252.220" />}</Field>
                  <Field label="Gateway">{(id) => <Input id={id} value={r.gateway} disabled={!canEdit} onChange={(e) => setRange(i, 'gateway', e.target.value)} placeholder="163.52.252.1" />}</Field>
                  <Field label="DNS">{(id) => <Input id={id} value={r.dns} disabled={!canEdit} onChange={(e) => setRange(i, 'dns', e.target.value)} placeholder="1.1.1.1" />}</Field>
                  {canEdit && (
                    <div className="flex items-end">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-crit"
                        onClick={() =>
                          set(
                            'ranges',
                            f.ranges.filter((_, j) => j !== i),
                          )
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </div>
              ))}
              {canEdit && (
                <div>
                  <Button type="button" size="sm" onClick={() => set('ranges', [...f.ranges, { network: '', start: '', end: '', gateway: '', dns: '' }])}>
                    Add a range
                  </Button>
                </div>
              )}
            </div>
          )}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Field label="Boot URL (optional)" hint={`What installing servers use to reach NexoraDC over HTTP. Now: ${q.data!.bootBase ?? 'not set'}`}>
              {(id) => <Input id={id} value={f.boot} disabled={!canEdit} onChange={(e) => set('boot', e.target.value)} placeholder={`http://${f.server || '163.52.252.10'}`} />}
            </Field>
            <Field label="Allowed networks" hint="Networks whose servers may fetch boot files and install settings (the server networks above are included)">
              {(id) => <Input id={id} value={f.allow} disabled={!canEdit} onChange={(e) => set('allow', e.target.value)} placeholder="163.52.252.0/24" />}
            </Field>
          </div>
          <ErrorNote error={save.error} />
          {canEdit && (
            <div className="flex justify-end">
              <Button type="submit" variant="primary" busy={save.isPending}>
                Save
              </Button>
            </div>
          )}
        </form>
      </Panel>
      <Panel title="Your network">
        <div className="flex flex-col gap-3">
          <ModeHelp mode={f.mode} server={f.server} ranges={f.ranges} />
          <div className="rounded-md bg-sunken p-3 text-[12.5px] text-ink-2">
            <p className="font-semibold">Also needed</p>
            <ul className="mt-1 list-disc pl-4">
              <li>UDP 67, 69 and 4011 open to this server (the installer opens them in firewalld/ufw).</li>
              <li>Port 80 reachable from the servers: boot files are served over HTTP, because network boot loaders cannot check certificates. Every link is tied to one install and stops working when it ends.</li>
              <li>A BMC control account on each server, so NexoraDC can set a one-time network boot and restart it.</li>
              <li>Debian network installs download packages from deb.debian.org; Ubuntu installs load the ISO into memory (a few GB of RAM).</li>
            </ul>
            <p className="mt-2">Network installs running now: {q.data!.activeNetworkInstalls}</p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
