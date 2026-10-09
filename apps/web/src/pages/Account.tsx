import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PASSWORD_MIN_LENGTH } from '@crapplet/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { describeAgent, formatDateTime, relativeTime } from '../lib/format';
import type { SessionRow } from '../lib/types';
import { Button, Chip, ConfirmDialog, ErrorNote, Field, Input, Loading, PageHeader, Panel, Table } from '../components/ui';

/** TOTP enrollment: scan QR → confirm a code → show recovery codes once. */
export function MfaSetup({ onDone }: { onDone?: () => void }) {
  const { refresh } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const begin = useMutation({ mutationFn: () => api.post<{ secret: string; qrDataUrl: string }>('/auth/mfa/setup'), onSuccess: setSetup });
  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code: code.trim() }),
    onSuccess: (r) => setCodes(r.recoveryCodes),
  });

  if (codes) {
    return (
      <div>
        <p className="font-medium text-ok">Two-step sign-in is on.</p>
        <p className="mt-1 text-ink-2">Save these recovery codes somewhere safe. Each one signs you in once if you lose your phone. They won’t be shown again.</p>
        <ol className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl border border-rule bg-sunken p-3 font-mono text-[13px] sm:grid-cols-5">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
        <div className="mt-3 flex gap-2">
          <Button onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}>Copy codes</Button>
          <Button
            variant="primary"
            onClick={async () => {
              await refresh();
              onDone?.();
            }}
          >
            I’ve saved them
          </Button>
        </div>
      </div>
    );
  }

  if (!setup) {
    return (
      <div>
        <p className="text-ink-2">Use an authenticator app such as Google Authenticator, Microsoft Authenticator or 1Password to generate sign-in codes.</p>
        <ErrorNote error={begin.error} className="mt-3" />
        <Button className="mt-3" variant="primary" busy={begin.isPending} onClick={() => begin.mutate()}>
          Set up authenticator
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4 sm:flex-row"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        enable.mutate();
      }}
    >
      <img src={setup.qrDataUrl} alt="QR code for your authenticator app" width={180} height={180} className="flex-none rounded-md border border-rule bg-white p-1" />
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-ink-2">Scan the code with your authenticator app, then enter the 6-digit code it shows.</p>
        <details className="text-[13px] text-ink-2">
          <summary className="cursor-pointer">Can’t scan? Enter the key manually</summary>
          <code className="mt-1 block font-mono break-all text-ink">{setup.secret}</code>
        </details>
        <Field label="6-digit code">
          {(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="w-36 font-mono tracking-[0.15em]" value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <ErrorNote error={enable.error} />
        <div>
          <Button type="submit" variant="primary" busy={enable.isPending} disabled={code.trim().length !== 6}>
            Turn on two-step sign-in
          </Button>
        </div>
      </div>
    </form>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/auth/password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirm('');
    },
  });
  const mismatch = confirm.length > 0 && confirm !== next;
  return (
    <form
      className="flex max-w-sm flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
      <Field label="New password" hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase is easier to remember than symbols.`}>
        {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
      </Field>
      <Field label="Confirm new password" error={mismatch ? 'Passwords don’t match' : undefined}>
        {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
      </Field>
      <ErrorNote error={m.error} />
      {m.isSuccess && <p className="text-[13px] text-ok">Password changed. Your other devices have been signed out.</p>}
      <div>
        <Button type="submit" variant="primary" busy={m.isPending} disabled={!current || next.length < PASSWORD_MIN_LENGTH || next !== confirm}>
          Change password
        </Button>
      </div>
    </form>
  );
}

function Sessions() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['my-sessions'], queryFn: () => api.get<SessionRow[]>('/auth/sessions') });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-sessions'] }),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} className="m-4" />;
  return (
    <>
      <ErrorNote error={revoke.error} className="m-4" />
      <Table label="Your active sessions">
        <thead>
          <tr>
            <th>Device</th>
            <th>IP address</th>
            <th>Signed in</th>
            <th>Last active</th>
            <th className="sr-only">Actions</th>
          </tr>
        </thead>
        <tbody>
          {q.data!.map((s) => (
            <tr key={s.id}>
              <td>
                {describeAgent(s.userAgent)} {s.current && <Chip tone="accent">This device</Chip>}
              </td>
              <td className="font-mono text-[13px]">{s.ip ?? '—'}</td>
              <td>{formatDateTime(s.createdAt)}</td>
              <td>{relativeTime(s.lastSeenAt)}</td>
              <td className="text-right">
                {!s.current && (
                  <Button size="sm" variant="ghost" busy={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>
                    Sign out
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

function DisableMfa() {
  const { refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/auth/mfa/disable', { password }),
    onSuccess: async () => {
      setOpen(false);
      setPassword('');
      await refresh();
    },
  });
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Turn off
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Turn off two-step sign-in?"
        body={
          <div className="flex flex-col gap-3">
            <p>Your account will be protected by your password alone, and your recovery codes will stop working.</p>
            <Field label="Confirm with your password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          </div>
        }
        confirmLabel="Turn off"
        busy={m.isPending}
        error={m.error}
        onConfirm={() => m.mutate()}
      />
    </>
  );
}

export function AccountPage() {
  const { me } = useAuth();
  if (!me) return null;
  return (
    <>
      <PageHeader title="Account and security" description={`Signed in as ${me.user.email}`} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel
          title="Two-step sign-in"
          actions={me.user.mfaEnabled ? <Chip tone="ok">On</Chip> : <Chip tone="warn">Off</Chip>}
        >
          {me.user.mfaEnabled ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-ink-2">
                You confirm sign-ins with your authenticator app. {me.user.recoveryCodesRemaining} recovery code{me.user.recoveryCodesRemaining === 1 ? '' : 's'} left.
              </p>
              <DisableMfa />
            </div>
          ) : (
            <MfaSetup />
          )}
        </Panel>
        <Panel title="Password">
          <PasswordForm />
        </Panel>
      </div>
      <Panel title="Where you’re signed in" className="mt-5" flush>
        <Sessions />
      </Panel>
    </>
  );
}
