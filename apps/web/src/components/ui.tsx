import * as Dialog from '@radix-ui/react-dialog';
import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ApiError } from '../lib/api';

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 border border-transparent shadow-[0_6px_18px_-8px_var(--accent)]',
  secondary: 'bg-field text-ink border border-rule-strong hover:bg-panel backdrop-blur-sm',
  ghost: 'text-ink-2 hover:text-ink hover:bg-sunken border border-transparent',
  danger: 'bg-crit text-white hover:brightness-110 border border-transparent',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; size?: 'sm' | 'md' }>(
  function Button({ variant = 'secondary', busy, size = 'md', className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={cx(
          'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-55',
          size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-9 px-3.5',
          VARIANTS[variant],
          className,
        )}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        {...rest}
      >
        {busy && <span className="size-3 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />}
        {children}
      </button>
    );
  },
);

const fieldBase =
  'rounded-lg border border-rule-strong bg-field px-2.5 text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:bg-sunken disabled:text-ink-3';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(fieldBase, widthOf(className), 'h-9', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(fieldBase, widthOf(className), 'min-h-20 py-2', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(fieldBase, widthOf(className), 'h-9 pr-7', className)} {...rest}>
      {children}
    </select>
  );
});

/** Controls fill their container unless the caller sets an explicit width. */
const widthOf = (className?: string) => (className && /(^|\s)w-/.test(className) ? '' : 'w-full');

/** Label + control + hint/error, wired with ids for screen readers. */
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: (id: string, describedBy?: string) => ReactNode }) {
  const id = useId();
  const descId = hint || error ? `${id}-desc` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[13px] font-medium text-ink-2">
        {label}
      </label>
      {children(id, descId)}
      {(error || hint) && (
        <p id={descId} className={cx('text-[12.5px]', error ? 'text-crit' : 'text-ink-3')}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

type Tone = 'ok' | 'warn' | 'crit' | 'est' | 'neutral' | 'accent';
const TONES: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  crit: 'bg-crit-soft text-crit',
  est: 'bg-est-soft text-est',
  neutral: 'bg-sunken text-ink-2',
  accent: 'bg-accent-soft text-accent',
};

export function Chip({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex h-5 items-center gap-1 rounded px-1.5 text-[12px] font-medium whitespace-nowrap', TONES[tone])}>
      {children}
    </span>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.01em]">{title}</h1>
        {description && <p className="mt-1 max-w-[70ch] text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({ title, actions, children, className, flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cx('glass rounded-2xl', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-rule px-4 py-3">
          {title && <h2 className="text-[14px] font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const e = error as Error;
  const rid = error instanceof ApiError ? error.requestId : undefined;
  const issues = error instanceof ApiError ? error.issues : undefined;
  return (
    <div role="alert" className={cx('rounded-md border border-crit/30 bg-crit-soft px-3 py-2 text-[13px] text-crit', className)}>
      <p className="font-medium">{e.message}</p>
      {issues && issues.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {issues.map((i) => (
            <li key={i.path + i.message}>
              {i.path ? <strong>{i.path}: </strong> : null}
              {i.message}
            </li>
          ))}
        </ul>
      )}
      {rid && <p className="mt-1 opacity-75">Reference: <span className="font-mono">{rid}</span></p>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="font-semibold">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-[52ch] text-ink-2">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-8 text-ink-3" role="status">
      <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />
      {label}…
    </div>
  );
}

/** Table shell: horizontal scroll on small screens, sticky header. */
export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full border-collapse text-left [&_td]:border-t [&_td]:border-rule [&_td]:px-4 [&_td]:py-2.5 [&_th]:bg-sunken [&_th]:px-4 [&_th]:py-2 [&_th]:text-[12.5px] [&_th]:font-semibold [&_th]:text-ink-2 [&_th]:whitespace-nowrap">
        {children}
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-rule px-4 py-2.5 text-[13px] text-ink-2">
      <span>
        {from}–{to} of {total}
      </span>
      <div className="flex gap-1.5">
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function Modal({ open, onOpenChange, title, description, children, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim fixed inset-0 z-40" />
        <Dialog.Content
          className={cx(
            'fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto glass-strong rounded-2xl p-5 focus:outline-none',
            wide ? 'max-w-2xl' : 'max-w-md',
          )}
        >
          <Dialog.Title className="text-[16px] font-semibold">{title}</Dialog.Title>
          {description ? <Dialog.Description className="mt-1 text-ink-2">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
          <div className="mt-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Confirmation for dangerous actions: names the consequence and the target. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
  busy,
  error,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  error?: unknown;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <div className="text-ink-2">{body}</div>
      <ErrorNote error={error} className="mt-3" />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="danger" busy={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-ink-2">{label}</dt>
      <dd className={cx('mt-0.5 text-[26px] leading-tight font-semibold tracking-[-0.02em]', tone && tone !== 'neutral' && TONES[tone].split(' ')[1])}>{value}</dd>
      {note && <dd className="mt-0.5 text-[12.5px] text-ink-3">{note}</dd>}
    </div>
  );
}
