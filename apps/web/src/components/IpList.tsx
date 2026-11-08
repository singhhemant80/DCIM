import { useState } from 'react';
import { cx } from './ui';

/** IP addresses shown prominently, each as a pill with a copy button (IPv4 first). */
export function IpList({ ips, size = 'md', empty = 'Not reported' }: { ips: string[]; size?: 'sm' | 'md' | 'lg'; empty?: string }) {
  if (!ips.length) return <span className="text-[13px] text-ink-3">{empty}</span>;
  const sorted = [...ips].sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')));
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {sorted.map((ip) => (
        <IpPill key={ip} ip={ip} size={size} />
      ))}
    </span>
  );
}

function IpPill({ ip, size }: { ip: string; size: 'sm' | 'md' | 'lg' }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(ip);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard not available */
    }
  };
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-lg border border-accent/30 bg-accent/10 font-mono font-semibold text-accent',
        size === 'lg' ? 'px-2.5 py-1 text-[15px]' : size === 'md' ? 'px-2 py-0.5 text-[13px]' : 'px-1.5 py-px text-[12px]',
      )}
    >
      {ip}
      <button type="button" onClick={copy} className="rounded px-0.5 text-[11px] font-sans font-medium text-accent/70 hover:text-accent" aria-label={`Copy ${ip}`} title="Copy">
        {copied ? '✓' : 'copy'}
      </button>
    </span>
  );
}
