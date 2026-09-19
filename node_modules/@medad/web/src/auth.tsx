import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { api, setTokens, clearTokens, hasToken } from './api.js';

export interface AuthUser {
  userId: string;
  tenantId: string;
  branchId: string | null;
  role: string;
  email: string;
  name: string;
  perms: string[];
}

interface AuthCtx {
  user: AuthUser | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  can: (perm: string) => boolean;
}

const Ctx = createContext<AuthCtx>({ user: null, ready: false, login: async () => undefined, logout: () => undefined, can: () => false });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!hasToken()) {
      setReady(true);
      return;
    }
    api<AuthUser>('/auth/me')
      .then(setUser)
      .catch(() => clearTokens())
      .finally(() => setReady(true));
  }, []);

  const login = async (email: string, password: string) => {
    const res = await api<{ user: AuthUser; accessToken: string; refreshToken: string }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setTokens(res.accessToken, res.refreshToken);
    setUser(res.user);
  };

  const logout = () => {
    clearTokens();
    setUser(null);
  };

  const can = (perm: string) => !!user && (user.perms.includes('*') || user.perms.includes(perm));

  return <Ctx.Provider value={{ user, ready, login, logout, can }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}

export function Login() {
  const { user, login } = useAuth();
  const [email, setEmail] = useState('admin@medad.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const year = new Date().getFullYear();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (user) return <Navigate to="/" replace />;

  return (
    <div className="login-page">
      <div className="login-wrap">
        <div className="login-head">
          <img src="/logo.png" alt="مداد" className="login-logo" />
          <h1 className="login-title">مداد</h1>
          <p className="login-sub">نظام إدارة ومحاسبة المكتبة</p>
        </div>

        <form className="card login-card" onSubmit={submit}>
          <h2>تسجيل الدخول</h2>
          <p className="login-hint">أدخل بياناتك للمتابعة إلى النظام</p>

          <label className="login-field">
            <span>البريد الإلكتروني</span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              required
              placeholder="name@example.com"
              autoComplete="username"
              dir="ltr"
            />
          </label>

          <label className="login-field">
            <span>كلمة المرور</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
              autoFocus
              placeholder="••••••••"
              autoComplete="current-password"
              dir="ltr"
            />
          </label>

          {error && <div className="alert bad">{error}</div>}

          <button className="btn login-btn" disabled={busy} type="submit">
            {busy ? 'جارٍ الدخول...' : 'دخول'}
          </button>
        </form>

        <footer className="login-footer">
          <svg className="login-footer-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
          <span>جميع الحقوق محفوظة © {year} مداد</span>
        </footer>
      </div>
    </div>
  );
}
