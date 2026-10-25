import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RPKI_LABELS, UPSTREAM_KINDS, UPSTREAM_KIND_LABELS, type RoutingFinding, type UpstreamCheckData, type UpstreamKind, type UpstreamPrefixStatus } from '@crapplet/shared';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { CheckNow } from './Routing';
import { Button, Chip, ConfirmDialog, ErrorNote, Field, Input, Modal, Select, Table, cx } from './ui';

/**
 * Upstreams and IX peering services (e.g. a provider that re-announces your
 * prefixes at exchanges): is your ASN in their AS-SET, does each prefix have
 * a route object, is the BGP session up and are your prefixes sent, and what
 * RIPE RIS sees through them. Read-only.
 */
export interface UpstreamT {
  id: string;
  asn: number;
  name: string;
  kind: UpstreamKind;
  asSet: string | null;
  notes: string | null;
  checkedAt: string | null;
  running: boolean;
  error: string | null;
  data: UpstreamCheckData | null;
  level: 'ok' | 'warning' | 'critical';
  findings: RoutingFinding[];
  prefixes: UpstreamPrefixStatus[];
}

const TONE = { ok: 'ok', warning: 'warn', critical: 'crit' } as const;
const LABEL = { ok: 'Announcing properly', warning: 'Check warnings', critical: 'Problems' } as const;
const FINDING: Record<RoutingFinding['level'], [string, string]> = { critical: ['text-crit', '●'], warning: ['text-warn', '▲'], ok: ['text-ok', '✓'], info: ['text-ink-2', '·'] };
const yes = (v: boolean | null, yesText: string, noText: string, unknown = 'Unknown') =>
  v === null ? <span className="text-ink-3">{unknown}</span> : v ? <span className="text-ok">{yesText}</span> : <span className="font-medium text-crit">{noText}</span>;

export function UpstreamDialog({ upstream, onClose }: { upstream?: UpstreamT; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ asn: upstream ? String(upstream.asn) : '', name: upstream?.name ?? '', kind: upstream?.kind ?? ('ix_peering' as UpstreamKind), asSet: upstream?.asSet ?? '', notes: upstream?.notes ?? '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () => {
      const body = { asn: Number(f.asn.trim().replace(/^AS/i, '')), name: f.name.trim(), kind: f.kind, asSet: f.asSet.trim() || null, notes: f.notes.trim() || null };
      return upstream ? api.put(`/ipam/routing/upstreams/${upstream.id}`, body) : api.post('/ipam/routing/upstreams', body);
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
      title={upstream ? `Edit ${upstream.name}` : 'Add upstream or IX peering'}
      description="A network your prefixes go out through, e.g. an IX peering service that re-announces them at exchanges, or a transit provider. Checked read-only every 6 hours."
    >
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={set('name')} placeholder="e.g. Joy Services" />}</Field>
        <Field label="Their ASN">{(id) => <Input id={id} required inputMode="numeric" className="font-mono" value={f.asn} onChange={set('asn')} placeholder="e.g. 152565" />}</Field>
        <Field label="Type">
          {(id) => (
            <Select id={id} value={f.kind} onChange={set('kind')}>
              {UPSTREAM_KINDS.map((k) => (
                <option key={k} value={k}>
                  {UPSTREAM_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Their customer AS-SET" hint='PeeringDB "IRR as-set", e.g. AS152565:AS-JOYSVC. Your ASN must be in it.'>
          {(id, d) => <Input id={id} aria-describedby={d} className="font-mono uppercase" value={f.asSet} onChange={set('asSet')} placeholder="AS152565:AS-JOYSVC" />}
        </Field>
        <ErrorNote error={m.error} className="sm:col-span-2" />
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} disabled={!/^(AS)?\d+$/i.test(f.asn.trim()) || !f.name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PrefixRows({ u }: { u: UpstreamT }) {
  if (!u.prefixes.length) return <p className="px-4 py-3 text-[13px] text-ink-3">No checked prefixes of yours yet.</p>;
  const routers = !!u.data?.routers.some((r) => r.sessions.length);
  return (
    <Table label={`Prefixes through ${u.name}`}>
      <thead>
        <tr>
          <th>Prefix</th>
          <th>Status</th>
          <th>Sent by your router</th>
          <th>IRR route object</th>
          <th>RPKI</th>
          <th>RIS sees it via AS{u.asn}</th>
        </tr>
      </thead>
      <tbody>
        {u.prefixes.map((p) => (
          <tr key={p.prefixId}>
            <td className="whitespace-nowrap">
              <span className="font-mono text-[13px] font-medium">{p.prefix}</span>
              {p.description && <div className="max-w-[22ch] truncate text-[12px] text-ink-3">{p.description}</div>}
            </td>
            <td>
              <Chip tone={TONE[p.level]}>{p.level === 'ok' ? 'OK' : p.level === 'warning' ? 'Warning' : 'Problem'}</Chip>
              {p.notes.map((n) => (
                <div key={n} className={cx('mt-0.5 max-w-[40ch] text-[12px]', p.level === 'critical' ? 'text-crit' : 'text-ink-2')}>
                  {n}
                </div>
              ))}
            </td>
            <td className="text-[13px]">{yes(p.advertised, 'Yes', 'Not sent', routers ? 'Router does not list it' : 'No router data')}</td>
            <td className="text-[13px]">
              {p.routeObject === null ? (
                <span className="text-ink-3">—</span>
              ) : p.routeObject === 'exact' ? (
                <span className="text-ok">Yes</span>
              ) : p.routeObject === 'covering' ? (
                <span className="text-warn">Only {p.coveringObject}</span>
              ) : (
                <span className="font-medium text-crit">Missing</span>
              )}
            </td>
            <td>{p.rpki ? <Chip tone={p.rpki === 'valid' ? 'ok' : p.rpki === 'unknown' ? 'warn' : 'crit'}>{RPKI_LABELS[p.rpki]}</Chip> : <span className="text-ink-3">—</span>}</td>
            <td className="text-[13px] tabular-nums">{p.seenVia ? `${p.seenVia} peer${p.seenVia === 1 ? '' : 's'}` : <span className="text-ink-3">{p.announced === false ? 'not announced' : 'not seen'}</span>}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function UpstreamCard({ u, writable, onEdit }: { u: UpstreamT; writable: boolean; onEdit: () => void }) {
  const qc = useQueryClient();
  const [del, setDel] = useState(false);
  const rm = useMutation({ mutationFn: () => api.delete(`/ipam/routing/upstreams/${u.id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['ipam'] }) });
  const sessions = u.data?.routers.flatMap((r) => r.sessions.map((s) => ({ ...s, router: r.name }))) ?? [];
  return (
    <section className="glass rounded-2xl">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold">{u.name}</h3>
            <a href={`https://bgp.tools/as/${u.asn}`} target="_blank" rel="noreferrer noopener" className="font-mono text-[13px] text-ink-2 hover:underline">
              AS{u.asn}
            </a>
            <span className="text-[12.5px] text-ink-3">{UPSTREAM_KIND_LABELS[u.kind]}</span>
            {u.data ? <Chip tone={TONE[u.level]}>{LABEL[u.level]}</Chip> : <span className="text-[12.5px] text-ink-3">{u.error ? 'Check failed' : 'Checking…'}</span>}
          </div>
          <div className="mt-0.5 text-[12.5px] text-ink-3">
            {u.asSet ? <span className="font-mono">{u.asSet}</span> : 'No AS-SET entered'}
            {u.checkedAt ? ` · checked ${relativeTime(u.checkedAt)}` : ''}
            {u.data?.irr.server ? ` · IRR via ${u.data.irr.server}` : ''}
          </div>
        </div>
        <div className="flex gap-1">
          <CheckNow body={{ upstreamId: u.id }} />
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
      <div className="grid gap-4 px-4 py-3 text-[13px] lg:grid-cols-2">
        <ul className="flex flex-col gap-1">
          {u.findings.map((f) => (
            <li key={f.code + f.text} className={cx('flex gap-2', FINDING[f.level][0])}>
              <span aria-hidden className="w-3 shrink-0 text-center">
                {FINDING[f.level][1]}
              </span>
              <span>{f.text}</span>
            </li>
          ))}
          {u.error && <li className="text-warn">Last check failed: {u.error}</li>}
        </ul>
        {sessions.length > 0 && (
          <div>
            <div className="mb-1 font-medium">BGP sessions to AS{u.asn} on your routers</div>
            <ul className="flex flex-col gap-0.5">
              {sessions.map((s) => (
                <li key={s.router + s.peer + s.name} className="flex flex-wrap items-center gap-2">
                  <span className={cx('size-1.5 rounded-full', s.state === 'established' ? 'bg-ok' : 'bg-crit')} aria-hidden />
                  <span>{s.router}</span>
                  <span className="font-mono text-[12.5px]">{s.name ?? ''}</span>
                  <span className="font-mono text-[12.5px] text-ink-3">{s.peer}</span>
                  <span className={s.state === 'established' ? 'text-ink-2' : 'text-crit'}>{s.state}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[12px] text-ink-3">Read from the routers (read-only) during the check.</p>
          </div>
        )}
      </div>
      <PrefixRows u={u} />
      <ConfirmDialog open={del} onOpenChange={setDel} title={`Remove ${u.name}?`} body="Only stops checking it. Nothing is changed on any router." confirmLabel="Remove" onConfirm={() => rm.mutate()} busy={rm.isPending} error={rm.error} />
    </section>
  );
}
