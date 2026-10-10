import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, ErrorNote, Field, Input } from '../components/ui';
import { LogoMark } from '../components/Logo';

type Step = { kind: 'password' } | { kind: 'mfa'; challengeToken: string };

export function LoginPage() {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ mfaRequired: boolean; challengeToken?: string }>('/auth/login', { email, password });
      if (res.mfaRequired && res.challengeToken) {
        setPassword('');
        setStep({ kind: 'mfa', challengeToken: res.challengeToken });
      } else {
        await qc.invalidateQueries({ queryKey: ['me'] });
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (step.kind !== 'mfa') return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/mfa/verify', { challengeToken: step.challengeToken, code: code.trim().toLowerCase() });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(err);
      if ((err as { code?: string }).code === 'mfa_challenge_invalid') {
        setStep({ kind: 'password' });
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(320px,0.9fr)_1.1fr]">
      <aside className="glass-rack relative hidden flex-col justify-between overflow-hidden p-10 text-rack-ink lg:flex">
        <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[14px] bg-[radial-gradient(circle_at_7px_11px,rgb(0_0_0/0.5)_2px,transparent_2.5px)] bg-[length:14px_22px]" />
        <div className="flex items-center gap-2.5 pl-4">
          <LogoMark size={26} />
          <span className="flex flex-col leading-none">
            <span className="text-[16px] font-semibold text-white">NexoraDC</span>
            <span className="mt-1 text-[11px] text-white/55">by Crapplet Cloud</span>
          </span>
        </div>
        <div className="max-w-[34ch] pl-4">
          <p className="text-[26px] leading-[1.2] font-semibold tracking-[-0.015em] text-white">Every rack, port and watt in one place.</p>
          <p className="mt-3 text-rack-ink/75">Data center infrastructure management, power analytics, asset management and monitoring for Crapplet Cloud staff and customers.</p>
        </div>
        <p className="pl-4 text-[12.5px] text-rack-ink/50">Access is logged. Use only accounts issued to you.</p>
      </aside>

      <main className="flex items-center justify-center px-4 py-12">
        <div className="glass w-full max-w-[400px] rounded-2xl p-7 sm:p-8">
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">{step.kind === 'password' ? 'Sign in' : 'Verify it’s you'}</h1>
          {step.kind === 'password' ? (
            <form className="mt-6 flex flex-col gap-4" onSubmit={submitPassword} noValidate>
              <Field label="Email">
                {(id) => <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}
              </Field>
              <Field label="Password">
                {(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}
              </Field>
              <ErrorNote error={error} />
              <Button type="submit" variant="primary" busy={busy} disabled={!email || !password}>
                Sign in
              </Button>
              <p className="text-[12.5px] text-ink-3">Forgot your password or lost your authenticator? Ask a Crapplet administrator to reset it.</p>
            </form>
          ) : (
            <form className="mt-2 flex flex-col gap-4" onSubmit={submitCode} noValidate>
              <p className="text-ink-2">
                {useRecovery ? 'Enter one of your saved recovery codes. Each code works once.' : 'Enter the 6-digit code from your authenticator app.'}
              </p>
              <Field label={useRecovery ? 'Recovery code' : 'Authentication code'}>
                {(id) => (
                  <Input
                    id={id}
                    autoFocus
                    autoComplete="one-time-code"
                    inputMode={useRecovery ? 'text' : 'numeric'}
                    placeholder={useRecovery ? 'xxxxx-xxxxx' : '123456'}
                    maxLength={useRecovery ? 11 : 6}
                    className="font-mono tracking-[0.15em]"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                )}
              </Field>
              <ErrorNote error={error} />
              <Button type="submit" variant="primary" busy={busy} disabled={code.trim().length < 6}>
                Verify and sign in
              </Button>
              <div className="flex justify-between text-[13px]">
                <button type="button" className="text-accent hover:underline" onClick={() => { setUseRecovery((v) => !v); setCode(''); setError(null); }}>
                  {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
                </button>
                <button type="button" className="text-ink-2 hover:underline" onClick={() => { setStep({ kind: 'password' }); setCode(''); setError(null); }}>
                  Start over
                </button>
              </div>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
