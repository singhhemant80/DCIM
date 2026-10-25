import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RPKI_LABELS, type AsnRoutingData, type PrefixRoutingData, type RoutingFinding } from '@crapplet/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import { UpstreamCard, UpstreamDialog, type UpstreamT } from './Upstreams';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, Panel, Select, Table, cx } from './ui';

/**
 * Global routing (BGP) check: whether each public prefix is in the global
 * routing table, from which origin AS and through which upstreams, and what
 * RPKI and the routing registries say. Observed from outside via RIPEstat;
 * nothing here announces or changes a route.
 */
export interface RoutingItemT {
  id: string;
  prefix: string;
  status: string;
  description: string | null;
  customerName: string | null;
  originAsn: number | null;
  routingCheck: boolean;
  checked: boolean;
  skipReason: string | null;
  running: boolean;
  level: 'ok' | 'warning' | 'critical' | null;
  checkedAt: string | null;
  nextAt: string | null;
  error: string | null;
  data: PrefixRoutingData | null;
}
interface AsnT {
  id: string;
  asn: number;
  name: string | null;
  asSet: string | null;
  notes: string | null;
  checkedAt: string | null;
  running: boolean;
  error: string | null;
  data: AsnRoutingData | null;
  notInIpam: string[];
}
interface OverviewT {
  enabled: boolean;
  source: string;
  asns: AsnT[];
  upstreams: UpstreamT[];
  totals: { prefixes: number; ok: number; warning: number; critical: number; pending: number };
  items: RoutingItemT[];
}

const LEVEL_LABEL = { ok: 'Routed OK', warning: 'Warning', critical: 'Problem' } as const;
const LEVEL_TONE = { ok: 'ok', warning: 'warn', critical: 'crit' } as const;
const FINDING_CLS: Record<RoutingFinding['level'], string> = { critical: 'text-crit', warning: 'text-warn', info: 'text-ink-2', ok: 'text-ok' };
const asLink = (n: number) => (
  <a href={`https://bgp.tools/as/${n}`} target="_blank" rel="noreferrer noopener" className="font-mono hover:underline">
    AS{n}
  </a>
);
const join = (xs: React.ReactNode[]) =>
  xs.map((x, i) => (
    <Fragment key={i}>
      {i > 0 && ', '}
      {x}
    </Fragment>
  ));

/** Status chip for prefix lists. */
export function RoutingChip({ level, error, summary, small }: { level: string | null; error?: string | null; summary?: string | null; small?: boolean }) {
  if (!level)
    return error ? (
      <span className={cx('text-warn', small ? 'text-[12px]' : 'text-[12.5px]')} title={error}>
        Check failed
      </span>
    ) : (
      <span className="text-[12.5px] text-ink-3">Checking…</span>
    );
  const l = level as keyof typeof LEVEL_TONE;
  return (
    <span title={[summary, error && `Last attempt failed: ${error}`].filter(Boolean).join('\n') || undefined}>
      <Chip tone={LEVEL_TONE[l] ?? 'neutral'}>{LEVEL_LABEL[l] ?? level}</Chip>
    </span>
  );
}

export function CheckNow({ body, label = 'Check now' }: { body: { prefixId?: string; asnId?: string; upstreamId?: string }; label?: string }) {
  const qc = useQueryClient();
  const m = useMutation({ mutationFn: () => api.post('/ipam/routing/check', body), onSuccess: () => setTimeout(() => void qc.invalidateQueries({ queryKey: ['ipam'] }), 4000) });
  return (
    <Button size="sm" variant="ghost" busy={m.isPending} disabled={m.isSuccess} onClick={() => m.mutate()}>
      {m.isSuccess ? 'Queued' : label}
    </Button>
  );
}

/** Everything known about one prefix's routing. */
export function RoutingDetail({ item }: { item: Pick<RoutingItemT, 'id' | 'prefix' | 'level' | 'checkedAt' | 'error' | 'data' | 'running' | 'nextAt'> }) {
  const d = item.data;
  if (!d) return <p className="text-[13px] text-ink-2">{item.error ? <span className="text-warn">Check failed: {item.error}</span> : 'Waiting for the first check (within a few minutes).'}</p>;
  const rows: [string, React.ReactNode][] = [
    [
      'Announced as',
      d.effective ? (
        <>
          <span className="font-mono">{d.effective.prefix}</span> from {join(d.effective.origins.map(asLink))}
          {d.effective.prefix !== item.prefix && <span className="text-ink-3"> (covering prefix)</span>}
        </>
      ) : (
        <span className="text-crit">Not in the global routing table</span>
      ),
    ],
    ['Expected origin', d.expectedAsns.length ? join(d.expectedAsns.map(asLink)) : <span className="text-warn">None set</span>],
    [
      'Visibility',
      d.visibility ? (
        <span className="inline-flex items-center gap-2">
          <span className="h-1.5 w-28 overflow-hidden rounded-full bg-sunken" aria-hidden>
            <span className={cx('block h-full', d.visibility.seeing / d.visibility.total >= 0.5 ? 'bg-ok' : 'bg-warn')} style={{ width: `${Math.min(100, (d.visibility.seeing / Math.max(1, d.visibility.total)) * 100)}%` }} />
          </span>
          <span className="tabular-nums">
            {d.visibility.seeing} of {d.visibility.total} RIS peers
          </span>
        </span>
      ) : (
        '—'
      ),
    ],
    [
      'RPKI',
      d.rpki.length ? (
        <span className="flex flex-col gap-0.5">
          {d.rpki.map((r) => (
            <span key={`${r.origin}${r.prefix}`}>
              <Chip tone={r.status === 'valid' ? 'ok' : r.status === 'unknown' ? 'warn' : 'crit'}>{RPKI_LABELS[r.status]}</Chip> <span className="font-mono text-[12.5px]">{r.prefix}</span> from AS{r.origin}
              {r.roas.length > 0 && <span className="text-ink-3"> · ROA {r.roas.map((x) => `${x.prefix} AS${x.origin}${x.maxLength ? ` max /${x.maxLength}` : ''}`).join('; ')}</span>}
            </span>
          ))}
        </span>
      ) : (
        '—'
      ),
    ],
    [
      'IRR route object',
      d.exact.length ? (
        join(
          d.exact.map((o) =>
            o.routeObjects.length ? (
              `AS${o.asn}: ${o.routeObjects.join(', ')}`
            ) : (
              <span key={o.asn} className="text-warn">
                AS{o.asn}: none
              </span>
            ),
          ),
        )
      ) : (
        <span className="text-ink-3">Exact prefix not announced</span>
      ),
    ],
    [
      'Upstreams',
      d.upstreams.length ? (
        <span className="flex flex-wrap gap-1">
          {d.upstreams.map((u) => (
            <span key={u.asn} className="rounded border border-rule px-1.5 text-[12.5px]" title={`Seen through AS${u.asn} by ${u.peers} RIS peer${u.peers === 1 ? '' : 's'}`}>
              {asLink(u.asn)} <span className="text-ink-3">{u.peers}</span>
            </span>
          ))}
        </span>
      ) : (
        <span className="text-ink-3">—</span>
      ),
    ],
  ];
  if (d.moreSpecifics.length)
    rows.push([
      'More specifics',
      join(
        d.moreSpecifics.map((m) => (
          <span key={m.prefix + m.origin}>
            <span className="font-mono">{m.prefix}</span> AS{m.origin}
          </span>
        )),
      ),
    ]);
  if (d.firstSeen) rows.push(['First seen', `${new Date(d.firstSeen.time).toLocaleDateString()}${d.firstSeen.origin ? ` from AS${d.firstSeen.origin}` : ''}`]);
  return (
    <div className="text-[13px]">
      {d.findings.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1">
          {d.findings.map((f) => (
            <li key={f.code + f.text} className={cx('flex gap-2', FINDING_CLS[f.level])}>
              <span aria-hidden>{f.level === 'critical' ? '●' : f.level === 'warning' ? '▲' : '·'}</span>
              {f.text}
            </li>
          ))}
        </ul>
      )}
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[150px_1fr]">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-ink-3">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </Fragment>
        ))}
      </dl>
      <p className="mt-3 text-[12px] text-ink-3">
        {item.running ? 'Checking now… ' : ''}
        Checked {item.checkedAt ? relativeTime(item.checkedAt) : '—'} (routing data from {d.queryTime ? `${d.queryTime.replace('T', ' ')} UTC` : 'RIS'}), again every 6 hours. Source: {d.source}. Observed from RIPE's route collectors; a
        network that doesn't peer with them may see it differently.
        {item.error && <span className="block text-warn">Last attempt failed: {item.error}</span>}
      </p>
    </div>
  );
}

/** The prefix page panel. */
export function PrefixRoutingPanel({ prefixId, prefix }: { prefixId: string; prefix: string }) {
  const q = useQuery({ queryKey: ['ipam', 'routing', prefixId], queryFn: () => api.get<Omit<RoutingItemT, 'id' | 'prefix'> & { checked: boolean }>(`/ipam/routing/prefixes/${prefixId}`) });
  if (!q.data) return null;
  if (!q.data.checked && !q.data.data) return null;
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Global routing (BGP) <RoutingChip level={q.data.level} error={q.data.error} />
        </span>
      }
      actions={<CheckNow body={{ prefixId }} />}
    >
      <RoutingDetail item={{ ...q.data, id: prefixId, prefix }} />
      {!q.data.checked && <p className="mt-2 text-[12.5px] text-ink-3">No longer checked: {q.data.skipReason}</p>}
    </Panel>
  );
}

function AsnDialog({ asn, onClose }: { asn?: AsnT; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ asn: asn ? String(asn.asn) : '', name: asn?.name ?? '', asSet: asn?.asSet ?? '', notes: asn?.notes ?? '' });
  const m = useMutation({
    mutationFn: () => {
      const body = { asn: Number(f.asn.trim().replace(/^AS/i, '')), name: f.name.trim() || null, asSet: f.asSet.trim() || null, notes: f.notes.trim() || null };
      return asn ? api.put(`/ipam/routing/asns/${asn.id}`, body) : api.post('/ipam/routing/asns', body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['ipam'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={asn ? `Edit AS${asn.asn}` : 'Add your ASN'}
      description="The autonomous system your prefixes should be announced from. Customer prefixes announced by the customer's own ASN can be given their own expected origin on the prefix."
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="ASN">{(id) => <Input id={id} required inputMode="numeric" className="font-mono" value={f.asn} onChange={(e) => setF((x) => ({ ...x, asn: e.target.value }))} placeholder="e.g. 141995" />}</Field>
        <Field label="Name (optional)">{(id) => <Input id={id} value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} />}</Field>
        <Field label="Your AS-SET (optional)" hint="If you have one, e.g. AS141995:AS-CUSTOMERS. Upstreams may list it in their set instead of your ASN.">
          {(id, d) => <Input id={id} aria-describedby={d} className="font-mono uppercase" value={f.asSet} onChange={(e) => setF((x) => ({ ...x, asSet: e.target.value }))} />}
        </Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} disabled={!/^(AS)?\d+$/i.test(f.asn.trim())}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AsnCard({ a, writable, onEdit }: { a: AsnT; writable: boolean; onEdit: () => void }) {
  const qc = useQueryClient();
  const [del, setDel] = useState(false);
  const rm = useMutation({ mutationFn: () => api.delete(`/ipam/routing/asns/${a.id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['ipam'] }) });
  const d = a.data;
  return (
    <div className="glass rounded-2xl p-4 text-[13px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[16px] font-semibold">{asLink(a.asn)}</div>
          <div className="text-ink-2">{[a.name, d?.holder].filter(Boolean).join(' · ') || '—'}</div>
          {a.asSet && <div className="font-mono text-[12px] text-ink-3">{a.asSet}</div>}
        </div>
        <div className="flex gap-1">
          <CheckNow body={{ asnId: a.id }} />
          {writable && (
            <>
              <Button size="sm" variant="ghost" onClick={onEdit}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" className="text-crit" onClick={() => setDel(true)}>
                Remove
              </Button>
            </>
          )}
        </div>
      </div>
      {d ? (
        <div className="mt-2 grid gap-1">
          <div className="tabular-nums">
            Announces {d.v4Prefixes ?? '—'} IPv4 and {d.v6Prefixes ?? '—'} IPv6 prefixes · {d.neighbours ?? '—'} neighbour ASes seen
          </div>
          {a.notInIpam.length > 0 && (
            <div className="text-warn">
              Announced but not in IPAM: <span className="font-mono">{a.notInIpam.join(', ')}</span>
            </div>
          )}
          <div className="text-[12px] text-ink-3">Checked {a.checkedAt ? relativeTime(a.checkedAt) : '—'}</div>
        </div>
      ) : (
        <div className="mt-2 text-ink-3">{a.error ? <span className="text-warn">Check failed: {a.error}</span> : 'Checking…'}</div>
      )}
      {d && a.error && <div className="text-[12px] text-warn">Last attempt failed: {a.error}</div>}
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title={`Remove AS${a.asn}?`}
        body="Prefixes are then compared with your other ASNs only. Nothing is changed on any router."
        confirmLabel="Remove"
        onConfirm={() => rm.mutate()}
        busy={rm.isPending}
        error={rm.error}
      />
    </div>
  );
}

/** IPAM tab: ASNs and every public prefix's routing. */
export function RoutingTab() {
  const { can } = useAuth();
  const writable = can('ipam.write');
  const q = useQuery({ queryKey: ['ipam', 'routing'], queryFn: () => api.get<OverviewT>('/ipam/routing'), refetchInterval: 30_000 });
  const [dialog, setDialog] = useState<AsnT | 'new' | null>(null);
  const [upDialog, setUpDialog] = useState<UpstreamT | 'new' | null>(null);
  const [filter, setFilter] = useState<'all' | 'critical' | 'warning' | 'ok' | 'unchecked'>('all');
  const [open, setOpen] = useState<string | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const o = q.data!;
  const items = o.items.filter((x) => (filter === 'all' ? true : filter === 'unchecked' ? !x.checked : x.checked && x.level === filter));
  return (
    <div className="grid gap-5">
      {!o.enabled && <div className="rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-[13px]">Routing checks are turned off on this server (CDCIM_ROUTING_CHECK=false). Results below are from before.</div>}
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold">Your ASNs</h2>
          {writable && (
            <Button size="sm" onClick={() => setDialog('new')}>
              Add ASN
            </Button>
          )}
        </div>
        {o.asns.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {o.asns.map((a) => (
              <AsnCard key={a.id} a={a} writable={writable} onEdit={() => setDialog(a)} />
            ))}
          </div>
        ) : (
          <div className="glass rounded-2xl">
            <EmptyState
              title="Add your ASN to start checking"
              action={
                writable ? (
                  <Button variant="primary" onClick={() => setDialog('new')}>
                    Add ASN
                  </Button>
                ) : undefined
              }
            >
              NexoraDC then checks every public prefix in the global table every 6 hours: is it in the global routing table, from your ASN, through which upstreams, with a valid ROA and an IRR route object. Nothing is announced or changed.
            </EmptyState>
          </div>
        )}
      </section>

      {o.asns.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-[15px] font-semibold">Upstreams and IX peering</h2>
              <p className="text-[12.5px] text-ink-3">Are your prefixes going out properly through each provider: AS-SET, route objects, BGP session, prefixes sent, RPKI.</p>
            </div>
            {writable && (
              <Button size="sm" onClick={() => setUpDialog('new')}>
                Add upstream
              </Button>
            )}
          </div>
          {o.upstreams.length ? (
            <div className="grid gap-4">
              {o.upstreams.map((u) => (
                <UpstreamCard key={u.id} u={u} writable={writable} onEdit={() => setUpDialog(u)} />
              ))}
            </div>
          ) : (
            <div className="glass rounded-2xl px-4 py-5 text-[13px] text-ink-2">
              Add the network that carries your prefixes to IXs or the internet — for example an IX peering service with its ASN and customer AS-SET (from its PeeringDB page) — to check that your prefixes are announced properly through it.
            </div>
          )}
        </section>
      )}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            ['Checked prefixes', o.totals.prefixes, ''],
            ['Problems', o.totals.critical, 'text-crit'],
            ['Warnings', o.totals.warning, 'text-warn'],
            ['Routed OK', o.totals.ok, 'text-ok'],
          ] as const
        ).map(([l, v, c]) => (
          <div key={l} className="glass rounded-2xl px-4 py-3">
            <dt className="text-[12.5px] text-ink-3">{l}</dt>
            <dd className={cx('text-[24px] font-semibold tabular-nums', v ? c : '')}>{v}</dd>
          </div>
        ))}
      </dl>

      <Panel
        title="Prefixes in the global routing table"
        flush
        actions={
          <div className="flex items-center gap-2">
            <Select aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="h-8 text-[13px]">
              <option value="all">All</option>
              <option value="critical">Problems</option>
              <option value="warning">Warnings</option>
              <option value="ok">Routed OK</option>
              <option value="unchecked">Not checked</option>
            </Select>
            {o.asns.length > 0 && <CheckNow body={{}} label="Check all now" />}
          </div>
        }
      >
        {items.length === 0 ? (
          <EmptyState title="No prefixes here">Public prefixes of the global table (IPv4 up to /24, IPv6 up to /48) are listed here. Private ranges and VRFs are never checked.</EmptyState>
        ) : (
          <Table label="Prefix routing">
            <thead>
              <tr>
                <th>Prefix</th>
                <th>Routing</th>
                <th>Announced from</th>
                <th>RPKI</th>
                <th>Visibility</th>
                <th>Upstreams</th>
                <th>Checked</th>
              </tr>
            </thead>
            <tbody>
              {items.map((x) => {
                const d = x.data;
                const expanded = open === x.id;
                return (
                  <Fragment key={x.id}>
                    <tr className={cx('cursor-pointer hover:bg-sunken/60', expanded && 'bg-sunken/60')} onClick={() => setOpen(expanded ? null : x.id)} aria-expanded={expanded}>
                      <td className="whitespace-nowrap">
                        <Link to={`/ipam/prefixes/${x.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-[13px] font-medium text-accent hover:underline">
                          {x.prefix}
                        </Link>
                        <div className="max-w-[24ch] truncate text-[12px] text-ink-3">{[x.customerName, x.description].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td>
                        {x.checked ? <RoutingChip level={x.level} error={x.error} /> : <span className="text-[12.5px] text-ink-3">{x.skipReason}</span>}
                        {d?.findings[0] && x.level !== 'ok' && <div className="mt-0.5 max-w-[34ch] text-[12px] text-ink-2">{d.findings.find((f) => f.level === x.level)?.text ?? d.findings[0].text}</div>}
                      </td>
                      <td className="text-[13px] whitespace-nowrap">
                        {d?.effective ? (
                          <>
                            {join(d.effective.origins.map(asLink))}
                            {d.effective.prefix !== x.prefix && <div className="font-mono text-[12px] text-ink-3">via {d.effective.prefix}</div>}
                          </>
                        ) : d ? (
                          <span className="text-crit">Not announced</span>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                        {x.originAsn && <div className="text-[12px] text-ink-3">expected AS{x.originAsn}</div>}
                      </td>
                      <td className="text-[13px]">
                        {d?.rpki.length ? (
                          d.rpki.map((r) => (
                            <div key={r.origin + r.prefix}>
                              <Chip tone={r.status === 'valid' ? 'ok' : r.status === 'unknown' ? 'warn' : 'crit'}>{RPKI_LABELS[r.status]}</Chip>
                            </div>
                          ))
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                      <td className="text-[13px] whitespace-nowrap tabular-nums">{d?.visibility && d.announced ? `${Math.round((d.visibility.seeing / Math.max(1, d.visibility.total)) * 100)}%` : <span className="text-ink-3">—</span>}</td>
                      <td className="max-w-[22ch] text-[12.5px]">
                        {d?.upstreams.length ? join(d.upstreams.slice(0, 4).map((u) => <span key={u.asn}>AS{u.asn}</span>)) : <span className="text-ink-3">—</span>}
                        {d && d.upstreams.length > 4 && <span className="text-ink-3"> +{d.upstreams.length - 4}</span>}
                      </td>
                      <td className="text-[12.5px] whitespace-nowrap text-ink-3">{x.running ? 'checking…' : x.checkedAt ? relativeTime(x.checkedAt) : x.checked ? 'pending' : ''}</td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={7} className="bg-sunken/40 px-6 py-4">
                          {x.checked || x.data ? <RoutingDetail item={x} /> : <span className="text-[13px] text-ink-3">{x.skipReason}</span>}
                          {x.checked && (
                            <div className="mt-2">
                              <CheckNow body={{ prefixId: x.id }} />
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        )}
        <p className="border-t border-rule px-4 py-2.5 text-[12px] text-ink-3">
          Observed from outside through {o.source}. Every 6 hours per prefix, or on "Check now". Read-only: NexoraDC never announces, withdraws or changes a route. Click a row for details.
        </p>
      </Panel>
      {dialog && <AsnDialog asn={dialog === 'new' ? undefined : dialog} onClose={() => setDialog(null)} />}
      {upDialog && <UpstreamDialog upstream={upDialog === 'new' ? undefined : upDialog} onClose={() => setUpDialog(null)} />}
    </div>
  );
}
