import { useState } from 'react';
import { NavLink, Outlet, useNavigate, useNavigation } from 'react-router-dom';
import { useAuth } from './auth.js';
import { Calculator, useLiveClock } from './ui.js';
import { RouteLoaderOverlay } from './Loader.js';
import { getTheme, toggleTheme, type Theme } from './theme.js';

const NAV: { to: string; label: string; perm: string }[] = [
  { to: '/', label: 'الرئيسية', perm: 'dashboard.view' },
  { to: '/pos', label: 'الكاشير (POS)', perm: 'pos.view' },
  { to: '/sales', label: 'المبيعات', perm: 'pos.view' },
  { to: '/inventory', label: 'المخزون', perm: 'inventory.view' },
  { to: '/purchases', label: 'المشتريات', perm: 'purchases.view' },
  { to: '/parties', label: 'العملاء والموردون', perm: 'parties.view' },
  { to: '/ledger', label: 'القيود والأستاذ', perm: 'ledger.view' },
  { to: '/reports', label: 'التقارير', perm: 'reports.view' },
  { to: '/counts', label: 'الجرد', perm: 'inventory.view' },
  { to: '/transfers', label: 'نقل بين الفروع', perm: 'inventory.view' },
  { to: '/tasks', label: 'المهام', perm: 'tasks.view' },
  { to: '/labels', label: 'الملصقات', perm: 'labels.print' },
  { to: '/sync', label: 'المزامنة والنسخ', perm: 'sync.view' },
  { to: '/settings', label: 'الإعدادات', perm: 'settings.view' },
];

const ROLE_AR: Record<string, string> = { manager: 'مدير', accountant: 'محاسب', cashier: 'كاشير', inventory: 'مخزون' };

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function Shell() {
  const { user, logout, can } = useAuth();
  const clock = useLiveClock();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const navigating = navigation.state !== 'idle';
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  const switchTheme = () => setThemeState(toggleTheme());

  const doLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img src="/logo.png" alt="شعار مداد" className="brand-logo" />
          <span>مداد — إدارة ومحاسبة المكتبة</span>
        </div>
        <div className="topbar-left">
          <Calculator />
          <button
            className="theme-toggle"
            onClick={switchTheme}
            title={theme === 'dark' ? 'التبديل إلى الوضع الفاتح' : 'التبديل إلى الوضع الداكن'}
            aria-label="تبديل المظهر"
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          <span className="live-clock">{clock}</span>
          {user && (
            <span className="user-chip">
              {user.name} · {ROLE_AR[user.role] ?? user.role}
              <button className="btn secondary small" onClick={doLogout}>خروج</button>
            </span>
          )}
        </div>
      </header>
      <div className="layout">
        <nav className="sidenav">
          {NAV.filter((n) => can(n.perm)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <main className="content" style={{ position: 'relative' }}>
          {navigating && <RouteLoaderOverlay />}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
