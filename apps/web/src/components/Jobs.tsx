import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, relativeTime } from '../lib/format';
import { isActive, jobKindLabel, jobStatusLabel, jobTone, type JobDetailT, type JobStepT } from '../lib/provisioning';
import type { JobStatus } from '@crapplet/shared';
import { Button, Chip, ErrorNote, Field, Loading, Modal, Textarea, cx } from './ui';

export function JobStatusChip({ status, cancelRequested, verified }: { status: JobStatus; cancelRequested?: boolean; verified?: boolean | null }) {
  if (status === 'completed' && verified === false)
    return (
      <Chip tone="warn" title="The request was carried out, but its effect could not be observed (see the job log)">
        Completed · not verified
      </Chip>
    );
  return (
    <Chip tone={jobTone(status)} title={cancelRequested && isActive(status) ? 'Cancellation requested; stopping after cleanup' : undefined}>
      {isActive(status) && status !== 'recovery' && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {jobStatusLabel(status)}
      {cancelRequested && isActive(status) ? ' · cancelling' : ''}
    </Chip>
  );
}

const STEP_DOT: Record<JobStepT['status'], string> = {
  pending: 'border-rule-strong bg-panel',
  running: 'border-accent bg-accent animate-pulse',
  done: 'border-ok bg-ok',
  failed: 'border-crit bg-crit',
  skipped: 'border-warn bg-warn-soft',
};

/** Steps in order, pending ones included, so it is clear what has and has not happened. */
export function StepTimeline({ steps, current, status }: { steps: JobStepT[]; current: number; status: JobStatus }) {
  const parked = status === 'waiting' || status === 'verifying';
  if (!steps.length) return <p className="text-ink-3">{status === 'queued' ? 'Waiting for the worker to pick the job up.' : 'No steps recorded.'}</p>;
  return (
    <ol className="relative flex flex-col gap-3 pl-5">
      <span className="absolute top-1.5 bottom-1.5 left-[5px] w-px bg-rule" aria-hidden />
      {steps.map((s) => {
        // A step that is polling (or backing off before a retry) keeps its row "running" while the job is parked.
        const waiting = s.seq === current && parked && (s.status === 'running' || s.status === 'pending');
        return (
          <li key={s.seq} className="relative">
            <span className={cx('absolute top-1.5 -left-5 size-[11px] rounded-full border-2', waiting ? 'border-accent bg-accent-soft' : STEP_DOT[s.status])} aria-hidden />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={cx('font-medium', s.status === 'pending' && !waiting && 'text-ink-3')}>{s.name}</span>
              <span className="text-[12.5px] text-ink-3">
                {waiting ? (status === 'verifying' ? 'checking' : 'waiting') : s.status === 'done' ? 'done' : s.status === 'failed' ? 'failed' : s.status === 'skipped' ? 'skipped' : s.status === 'running' ? 'running' : 'not started'}
                {s.attempts > 1 ? ` · attempt ${s.attempts}` : ''}
                {s.finishedAt ? ` · ${formatDateTime(s.finishedAt)}` : s.startedAt ? ` · started ${relativeTime(s.startedAt)}` : ''}
              </span>
            </div>
            {s.detail && <p className="text-[13px] text-ink-2">{s.detail}</p>}
            {s.error && <p className="text-[13px] text-crit">{s.error}</p>}
          </li>
        );
      })}
    </ol>
  );
}

/** Job detail with live progress; staff with provisioning.execute can cancel or decide on recovery. */
export function JobModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can, me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const canExecute = staff && can('provisioning.execute');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['provisioning', 'job', id],
    queryFn: () => api.get<JobDetailT>(`/provisioning/jobs/${id}`),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data && !isActive(query.state.data.status) ? false : 3000),
  });
  const [note, setNote] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['provisioning'] });
  };
  const cancel = useMutation({ mutationFn: () => api.post(`/provisioning/jobs/${id}/cancel`), onSuccess: refresh });
  const decide = useMutation({ mutationFn: (decision: 'retry' | 'skip' | 'fail') => api.post(`/provisioning/jobs/${id}/recovery`, { decision, note: note.trim() || undefined }), onSuccess: () => (setNote(''), refresh()) });
  const j = q.data;
  const target = j?.deviceName ?? j?.guestName ?? j?.imageName ?? '';
  return (
    <Modal open={!!id} onOpenChange={(o) => !o && onClose()} title={j ? `${jobKindLabel(j.kind)}${target ? ` · ${target}` : ''}` : 'Job'} wide>
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} />
      {j && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
            <JobStatusChip status={j.status} cancelRequested={j.cancelRequested} verified={j.verified} />
            {typeof j.params.action === 'string' && <span>Action: {String(j.params.action).replace(/_/g, ' ')}</span>}
            {typeof j.params.method === 'string' && <span>· {j.params.method === 'pxe' ? 'PXE / iPXE' : 'Redfish virtual media'}</span>}
            {typeof j.params.hostname === 'string' && <span>· as {String(j.params.hostname)}</span>}
            <span>· requested by {j.createdBy} {relativeTime(j.createdAt)}</span>
            {j.deadlineAt && isActive(j.status) && <span>· times out {formatDateTime(j.deadlineAt)}</span>}
          </div>
          {j.status === 'completed' &&
            (j.result?.verified === false ? (
              <p className="rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
                Completed{j.finishedAt ? ` ${formatDateTime(j.finishedAt)}` : ''}, but not independently verified: {String(j.result.note ?? '')}.
              </p>
            ) : (
              <p className="rounded-md bg-ok-soft px-3 py-2 text-[13px] text-ok">Completed and verified{j.finishedAt ? ` ${formatDateTime(j.finishedAt)}` : ''}.</p>
            ))}
          {j.error && <p className="rounded-md bg-crit-soft px-3 py-2 text-[13px] text-crit">{j.error}</p>}
          {j.status === 'recovery' && (
            <div className="rounded-lg border border-warn/40 bg-warn-soft p-3 text-[13px]">
              <p className="font-semibold text-warn">The job stopped inside a step that is not safe to repeat.</p>
              <p className="mt-1 text-ink-2">
                Check the equipment (for example, the BMC’s power state and log) before choosing. <strong>Retry</strong> runs the step again, <strong>Skip</strong> treats it as done because you confirmed it happened, <strong>Fail</strong> stops the job and runs its cleanup.
              </p>
              {canExecute && (
                <>
                  <div className="mt-2">
                    <Field label="Note (kept in the job log and audit trail)">{(fid) => <Textarea id={fid} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" busy={decide.isPending && decide.variables === 'retry'} onClick={() => decide.mutate('retry')}>
                      Retry step
                    </Button>
                    <Button size="sm" busy={decide.isPending && decide.variables === 'skip'} onClick={() => decide.mutate('skip')}>
                      Skip step
                    </Button>
                    <Button size="sm" variant="danger" busy={decide.isPending && decide.variables === 'fail'} onClick={() => decide.mutate('fail')}>
                      Fail job
                    </Button>
                  </div>
                  <ErrorNote error={decide.error} className="mt-2" />
                </>
              )}
            </div>
          )}
          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink-2">Steps</h3>
            <StepTimeline steps={j.steps} current={j.currentStep} status={j.status} />
          </section>
          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink-2">Log</h3>
            <ol className="max-h-60 overflow-y-auto rounded-lg bg-sunken p-2 font-mono text-[12px]">
              {j.events.map((e) => (
                <li key={e.id} className={cx('py-0.5', e.level === 'error' ? 'text-crit' : e.level === 'warn' ? 'text-warn' : 'text-ink-2')}>
                  <span className="text-ink-3">{formatDateTime(e.at)}</span> {e.message}
                </li>
              ))}
            </ol>
          </section>
          {canExecute && isActive(j.status) && !j.cancelRequested && (
            <div className="flex items-center justify-end gap-2 border-t border-rule pt-3">
              <span className="mr-auto text-[12.5px] text-ink-3">Cancelling stops at the next step boundary and undoes boot overrides and inserted media.</span>
              <Button variant="danger" busy={cancel.isPending} onClick={() => cancel.mutate()}>
                Cancel job
              </Button>
            </div>
          )}
          <ErrorNote error={cancel.error} />
        </div>
      )}
    </Modal>
  );
}
