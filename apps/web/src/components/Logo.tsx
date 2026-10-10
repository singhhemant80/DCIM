import { useId } from 'react';

/** NexoraDC brand mark: an "N" drawn as a cable run with two connection points. */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  const path = 'M10 24.5V7.5L22 24.5V7.5';
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <linearGradient id={`nx-${id}`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#1E6BFF" />
          <stop offset="1" stopColor="#22D3EE" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill="#1A1856" />
      <path d={path} fill="none" stroke={`url(#nx-${id})`} strokeWidth="4" />
      <path d={path} fill="none" stroke="#1A1856" strokeWidth="1" />
      <circle cx="10" cy="18" r="2.6" fill="#1E6BFF" />
      <circle cx="10" cy="18" r=".9" fill="#1A1856" />
      <circle cx="22" cy="12.5" r="2.6" fill="#22D3EE" />
      <circle cx="22" cy="12.5" r=".9" fill="#1A1856" />
    </svg>
  );
}
