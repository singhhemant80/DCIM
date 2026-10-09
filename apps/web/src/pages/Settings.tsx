import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, ErrorNote, Field, Input, Loading, PageHeader, Panel, Select } from '../components/ui';

interface Settings {
  organizationName: string;
  slug: string;
  timezone: string;
  currency: string;
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  requireMfaForStaff: boolean;
}

const TIMEZONES = ['Asia/Kolkata', 'UTC', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York'];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'];

export function SettingsPage() {
  const { can, refresh, me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/settings') });
  const [f, setF] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const readOnly = !can('settings.write');
  const save = useMutation({
    mutationFn: (body: Partial<Settings>) => api.patch<Settings>('/settings', body),
    onSuccess: async (data) => {
      qc.setQueryData(['settings'], data);
      await refresh();
    },
  });
  if (q.isLoading || !f) return q.error ? <ErrorNote error={q.error} /> : <Loading />;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setF({ ...f, [k]: v });
  const enforcingWithoutOwnMfa = f.requireMfaForStaff && !q.data!.requireMfaForStaff && !me?.user.mfaEnabled;

  return (
    <>
      <PageHeader title="System settings" description={readOnly ? 'You can view these settings. Changing them needs the “Change system settings” permission.' : 'Changes take effect immediately and are recorded in the audit log.'} />
      <form
        className="flex flex-col gap-5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          const { slug: _slug, ...body } = f;
          save.mutate(body);
        }}
      >
        <Panel title="Organization">
          <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
            <Field label="Organization name">{(id) => <Input id={id} disabled={readOnly} value={f.organizationName} onChange={(e) => set('organizationName', e.target.value)} />}</Field>
            <Field label="Short name" hint="Fixed at installation.">
              {(id, d) => <Input id={id} aria-describedby={d} disabled value={f.slug} className="font-mono" />}
            </Field>
            <Field label="Time zone" hint="Used for reports and displayed times.">
              {(id, d) => (
                <Select id={id} aria-describedby={d} disabled={readOnly} value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
                  {[...new Set([f.timezone, ...TIMEZONES])].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Currency" hint="Used for electricity cost estimates.">
              {(id, d) => (
                <Select id={id} aria-describedby={d} disabled={readOnly} value={f.currency} onChange={(e) => set('currency', e.target.value)}>
                  {[...new Set([f.currency, ...CURRENCIES])].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </Panel>
        <Panel title="Sign-in security">
          <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
            <Field label="Sign out after inactivity (minutes)" hint="5 to 1440.">
              {(id, d) => <Input id={id} aria-describedby={d} type="number" min={5} max={1440} disabled={readOnly} value={f.sessionIdleMinutes} onChange={(e) => set('sessionIdleMinutes', Number(e.target.value))} />}
            </Field>
            <Field label="Maximum session length (hours)" hint="Applies to new sign-ins. 1 to 720.">
              {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={720} disabled={readOnly} value={f.sessionMaxHours} onChange={(e) => set('sessionMaxHours', Number(e.target.value))} />}
            </Field>
          </div>
          <label className={`mt-5 flex max-w-3xl items-start gap-2.5 ${readOnly ? 'opacity-60' : 'cursor-pointer'}`}>
            <input type="checkbox" className="mt-1 accent-[var(--accent)]" disabled={readOnly} checked={f.requireMfaForStaff} onChange={(e) => set('requireMfaForStaff', e.target.checked)} />
            <span>
              <span className="font-medium">Require two-step sign-in for all staff</span>
              <span className="block text-[13px] text-ink-2">Staff without an authenticator must set one up before they can use anything else.</span>
            </span>
          </label>
          {enforcingWithoutOwnMfa && <p className="mt-3 max-w-3xl rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">You haven’t set up two-step sign-in yourself, so you’ll be asked to do it right after saving.</p>}
        </Panel>
        <ErrorNote error={save.error} />
        {!readOnly && (
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" busy={save.isPending}>
              Save settings
            </Button>
            {save.isSuccess && !save.isPending && <span className="text-[13px] text-ok">Saved.</span>}
          </div>
        )}
      </form>
    </>
  );
}
