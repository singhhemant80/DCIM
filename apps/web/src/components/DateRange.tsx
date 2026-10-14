import { Input, Select, cx } from './ui';

/** Today as YYYY-MM-DD in the browser's local time. */
export function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A preset period, or 'custom' with whole days (both included, organization time zone). */
export interface PeriodValue<P extends string = string> {
  period: P | 'custom';
  from: string;
  to: string;
}

/** Query parameters for a period: from / to only when custom. */
export function periodParams<P extends string>(v: PeriodValue<P>) {
  return v.period === 'custom' ? { period: 'custom', from: v.from, to: v.to } : { period: v.period };
}

/** A custom period needs both dates, in order. */
export function periodReady<P extends string>(v: PeriodValue<P>) {
  return v.period !== 'custom' || (!!v.from && !!v.to && v.from <= v.to);
}

export function periodLabel<P extends string>(v: PeriodValue<P>, labels: Record<P, string>) {
  return v.period === 'custom' ? (v.from === v.to ? v.from : `${v.from} – ${v.to}`) : labels[v.period as P];
}

function DayInputs({ from, to, onChange, max }: { from: string; to: string; onChange: (r: { from: string; to: string }) => void; max?: string }) {
  const bad = !!from && !!to && from > to;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Input type="date" aria-label="From date" className={cx('w-[9.5rem]', bad && 'border-crit')} value={from} max={max} onChange={(e) => onChange({ from: e.target.value, to })} />
      <span className="text-[12px] text-ink-3">to</span>
      <Input type="date" aria-label="To date" className={cx('w-[9.5rem]', bad && 'border-crit')} value={to} max={max} onChange={(e) => onChange({ from, to: e.target.value })} />
      {bad && <span className="text-[12px] text-crit">Start is after end</span>}
    </span>
  );
}

/**
 * Period dropdown with the presets and "Custom dates"; choosing custom shows
 * two date fields (default: the last 7 days).
 */
export function PeriodPicker<P extends string>({
  value,
  onChange,
  options,
  labels,
  className,
  prefix = '',
}: {
  value: PeriodValue<P>;
  onChange: (v: PeriodValue<P>) => void;
  options: readonly P[];
  labels: Record<P, string>;
  className?: string;
  prefix?: string;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Period"
        className={className ?? 'w-44'}
        value={value.period}
        onChange={(e) => {
          const period = e.target.value as P | 'custom';
          onChange({ period, from: value.from || today(-6), to: value.to || today() });
        }}
      >
        {options.map((p) => (
          <option key={p} value={p}>
            {prefix}
            {labels[p]}
          </option>
        ))}
        <option value="custom">{prefix}Custom dates…</option>
      </Select>
      {value.period === 'custom' && <DayInputs from={value.from} to={value.to} max={today()} onChange={(r) => onChange({ ...value, ...r })} />}
    </span>
  );
}

/** Date filter for lists: optional from / to days, with a clear button. */
export function DateFilter({ from, to, onChange, label = 'Date' }: { from: string; to: string; onChange: (r: { from: string; to: string }) => void; label?: string }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`${label} filter`}>
      <span className="text-[12.5px] text-ink-2">{label}</span>
      <DayInputs from={from} to={to} onChange={onChange} />
      {(from || to) && (
        <button type="button" className="text-[12.5px] text-accent hover:underline" onClick={() => onChange({ from: '', to: '' })}>
          Clear
        </button>
      )}
    </span>
  );
}

/** Query parameters for a list date filter (only valid, filled-in values). */
export function dateParams(from: string, to: string) {
  if (from && to && from > to) return {};
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}
