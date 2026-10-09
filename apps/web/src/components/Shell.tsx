import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { NAV_SECTIONS, type NavSection } from '@crapplet/shared';
import { useAuth } from '../lib/auth';
import { getTheme, setTheme, type ThemeChoice } from '../lib/theme';
import { cx } from './ui';

const GROUP_ORDER: NavSection['group'][] = ['Overview', 'Physical', 'Network', 'Power', 'Services', 'Operations', 'Administration'];

/** Sections the current user may open. Customer users never see staff administration. */
export function useVisibleSections(): NavSection[] {
  const { me, can } = useAuth();
  return NAV_SECTIONS.filter((s) => {
    if (me?.user.userType === 'customer' && s.group === 'Administration') return false;
    return !s.permission || can(s.permission);
  });
}

/**
 * The sidebar is drawn as a rack: each section is one unit with a status LED.
 * A lit LED means the section is built and working; a dark LED with a phase
 * number means it is planned. The navigation itself tells the truth about
 * what exists.
 */
function RackNav({ onNavigate }: { onNavigate?: () => void }) {
  const sections = useVisibleSections();
  const groups = GROUP_ORDER.map((g) => ({ g, items: sections.filter((s) => s.group === g) })).filter((x) => x.items.length);
  const built = sections.filter((s) => s.status === 'available').length;
  return (
    <nav aria-label="Main" className="relative flex-1 overflow-y-auto pb-6">
      {/* Rack rail with mounting holes */}
      <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[10px] bg-[radial-gradient(circle_at_5px_9px,rgb(0_0_0/0.45)_1.6px,transparent_2px)] bg-[length:10px_18px] opacity-80" />
      <p className="px-5 pt-1 pb-3 text-[12px] text-rack-ink/70">
        {built} of {sections.length} sections live
      </p>
      {groups.map(({ g, items }) => (
        <div key={g} className="mb-3">
          <p className="px-5 pb-1 text-[12px] font-medium text-rack-ink/55">{g}</p>
          <ul>
            {items.map((s) => {
              const live = s.status === 'available';
              return (
                <li key={s.key}>
                  <NavLink
                    to={s.path}
                    end={s.path === '/'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cx(
                        'group mx-2 ml-4 flex h-8 items-center gap-2.5 rounded-[5px] border-t border-white/[0.04] px-2.5 text-[13.5px]',
                        isActive ? 'bg-white/[0.09] text-white' : live ? 'text-rack-ink hover:bg-white/[0.05] hover:text-white' : 'text-rack-ink/55 hover:bg-white/[0.04] hover:text-rack-ink',
                      )
                    }
                  >
                    <span className={cx('led', live && 'led-on')} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    {!live && (
                      <span className="text-[11px] text-rack-ink/45" title={`Planned for Phase ${s.phase}`}>
                        P{s.phase}
                      </span>
                    )}
                    <span className="sr-only">{live ? '(available)' : `(planned, phase ${s.phase})`}</span>
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex h-14 items-center gap-2.5 px-5">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <rect x="5" y="3" width="22" height="26" rx="2" fill="#2F4BC4" />
        <g fill="#fff">
          <rect x="8" y="7" width="16" height="3" rx=".6" />
          <rect x="8" y="12" width="16" height="3" rx=".6" />
          <rect x="8" y="17" width="16" height="3" rx=".6" />
        </g>
        <circle cx="21.5" cy="24.5" r="1.6" fill="#5BE0A0" />
      </svg>
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-white">Crapplet DCIM</span>
    </div>
  );
}

function ThemeSwitch() {
  const [theme, set] = useState<ThemeChoice>(getTheme());
  const options: { v: ThemeChoice; label: string }[] = [
    { v: 'light', label: 'Light' },
    { v: 'dark', label: 'Dark' },
    { v: 'system', label: 'Auto' },
  ];
  return (
    <div role="radiogroup" aria-label="Colour theme" className="flex rounded-md border border-rule p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={theme === o.v}
          onClick={() => {
            setTheme(o.v);
            set(o.v);
          }}
          className={cx('h-6 rounded px-2 text-[12px]', theme === o.v ? 'bg-sunken font-medium text-ink' : 'text-ink-3 hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function UserMenu() {
  const { me, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  if (!me) return null;
  const initials = me.user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-sunken"
      >
        <span className="grid size-7 place-items-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">{initials}</span>
        <span className="hidden text-left leading-tight sm:block">
          <span className="block text-[13px] font-medium">{me.user.name}</span>
          <span className="block text-[12px] text-ink-3">{me.user.userType === 'staff' ? me.organization.name : 'Customer portal'}</span>
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div role="menu" className="absolute right-0 z-40 mt-1 w-56 rounded-lg border border-rule bg-panel p-1 shadow-[0_12px_32px_-12px_rgb(10_16_24/0.35)]">
            <p className="truncate px-2.5 py-1.5 text-[12.5px] text-ink-3">{me.user.email}</p>
            <NavLink role="menuitem" to="/account" onClick={() => setOpen(false)} className="block rounded-md px-2.5 py-1.5 hover:bg-sunken">
              Account and security
            </NavLink>
            <button role="menuitem" onClick={() => void signOut()} className="block w-full rounded-md px-2.5 py-1.5 text-left hover:bg-sunken">
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setMobileOpen(false), [loc.pathname]);

  return (
    <div className="flex h-full">
      <a href="#main" className="sr-only z-50 rounded bg-panel px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>
      <aside className="hidden w-[248px] flex-none flex-col bg-rack lg:flex">
        <Brand />
        <RackNav />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-[#0a1018]/50" onClick={() => setMobileOpen(false)} aria-hidden />
          <aside className="relative flex h-full w-[264px] flex-col bg-rack">
            <Brand />
            <RackNav onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 flex-none items-center justify-between gap-3 border-b border-rule bg-panel px-4 lg:px-6">
          <button className="rounded-md p-1.5 hover:bg-sunken lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <div className="flex-1" />
          <ThemeSwitch />
          <UserMenu />
        </header>
        <main id="main" className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1280px] px-4 py-6 lg:px-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
