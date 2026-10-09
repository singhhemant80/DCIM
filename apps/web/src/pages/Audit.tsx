import { Fragment, useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import type { AuditEvent } from '../lib/types';
import { Button, Chip, EmptyState, ErrorNote, Input, Loading, PageHeader, Pagination, Panel, Select, Table } from '../components/ui';

const OUTCOME_TONE = { success: 'ok', failure: 'crit', denied: 'warn' } as const;
const OUTCOME_LABEL = { success: 'Success', failure: 'Failed', denied: 'Denied' } as const;

export function AuditPage() {
  const { me } = useAuth();
  const tz = me?.organization.timezone;
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? 1);
  const action = params.get('action') ?? '';
  const outcome = params.get('outcome') ?? '';
  const [actionInput, setActionInput] = useState(action);
  const [open, setOpen] = useState<number | null>(null);

  const list = useQuery({
    queryKey: ['audit', { page, action, outcome }],
    queryFn: () => api.get<Paginated<AuditEvent>>(`/audit${qs({ page, pageSize: 50, action, outcome })}`),
    placeholderData: keepPreviousData,
  });
  const verify = useMutation({ mutationFn: () => api.get<{ ok: boolean; checked: number; brokenAtId: number | null }>('/audit/verify') });
  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every sign-in, permission denial and change, in order. Records can’t be edited or deleted, and each one is chained to the previous so tampering is detectable."
        actions={
          <Button busy={verify.isPending} onClick={() => verify.mutate()}>
            Verify integrity
          </Button>
        }
      />
      {verify.data && (
        <p role="status" className={`mb-4 rounded-md px-3 py-2 text-[13px] ${verify.data.ok ? 'bg-ok-soft text-ok' : 'bg-crit-soft text-crit'}`}>
          {verify.data.ok ? `Intact. All ${verify.data.checked} records match their hashes.` : `Chain broken at record #${verify.data.brokenAtId}. A record was altered or removed outside the application.`}
        </p>
      )}
      <ErrorNote error={verify.error} className="mb-4" />
      <Panel flush>
        <form
          role="search"
          className="flex flex-wrap gap-2 border-b border-rule p-3"
          onSubmit={(e) => {
            e.preventDefault();
            update({ action: actionInput.trim(), page: '' });
          }}
        >
          <label className="sr-only" htmlFor="audit-action">Action</label>
          <Input id="audit-action" placeholder="Exact action, e.g. auth.login" value={actionInput} onChange={(e) => setActionInput(e.target.value)} className="max-w-xs font-mono text-[13px]" />
          <label className="sr-only" htmlFor="audit-outcome">Outcome</label>
          <Select id="audit-outcome" className="w-40" value={outcome} onChange={(e) => update({ outcome: e.target.value, page: '' })}>
            <option value="">All outcomes</option>
            <option value="success">Success</option>
            <option value="failure">Failed</option>
            <option value="denied">Denied</option>
          </Select>
          <Button type="submit">Filter</Button>
        </form>
        {list.isLoading && <Loading />}
        <ErrorNote error={list.error} className="m-4" />
        {list.data && list.data.items.length === 0 && <EmptyState title="No matching events">Clear the filters to see all activity.</EmptyState>}
        {list.data && list.data.items.length > 0 && (
          <>
            <Table label="Audit events">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Result</th>
                  <th>IP address</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((e) => (
                  <Fragment key={e.id}>
                    <tr className="cursor-pointer hover:bg-sunken/50" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                      <td className="whitespace-nowrap text-ink-2">{formatDateTime(e.occurredAt, tz)}</td>
                      <td>{e.actorLabel ?? e.actorType}</td>
                      <td className="font-mono text-[12.5px]">{e.action}</td>
                      <td className="text-ink-2">{e.targetType ?? '—'}</td>
                      <td>
                        <Chip tone={OUTCOME_TONE[e.outcome]}>{OUTCOME_LABEL[e.outcome]}</Chip>
                      </td>
                      <td className="font-mono text-[12.5px] text-ink-2">{e.ip ?? '—'}</td>
                    </tr>
                    {open === e.id && (
                      <tr>
                        <td colSpan={6} className="bg-sunken/50">
                          <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[140px_1fr]">
                            <dt className="text-ink-3">Record</dt>
                            <dd className="font-mono">#{e.id}</dd>
                            <dt className="text-ink-3">Target id</dt>
                            <dd className="font-mono break-all">{e.targetId ?? '—'}</dd>
                            <dt className="text-ink-3">Request id</dt>
                            <dd className="font-mono break-all">{e.requestId ?? '—'}</dd>
                            <dt className="text-ink-3">Client</dt>
                            <dd className="break-all">{e.userAgent ?? '—'}</dd>
                            <dt className="text-ink-3">Details</dt>
                            <dd>
                              <pre className="overflow-x-auto rounded-lg border border-rule bg-field p-2 font-mono text-[12px]">{JSON.stringify(e.metadata, null, 2)}</pre>
                            </dd>
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </Table>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => update({ page: String(p) })} />
          </>
        )}
      </Panel>
    </>
  );
}
