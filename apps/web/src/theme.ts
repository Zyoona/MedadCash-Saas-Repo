export type Theme = 'light' | 'dark';

const KEY = 'medad_theme';
const META_BG: Record<Theme, string> = { light: '#f1f5f9', dark: '#1d2534' };

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme: Theme): void {
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', META_BG[theme]);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* تجاهل */
  }
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
