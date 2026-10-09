export type ThemeChoice = 'light' | 'dark' | 'system';

export function getTheme(): ThemeChoice {
  try {
    const t = localStorage.getItem('cdcim-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(t: ThemeChoice): void {
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
  try {
    if (t === 'system') localStorage.removeItem('cdcim-theme');
    else localStorage.setItem('cdcim-theme', t);
  } catch {
    /* storage unavailable: theme still applies for this page view */
  }
}
