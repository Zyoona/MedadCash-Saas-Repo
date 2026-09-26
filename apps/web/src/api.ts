// API client: fetch + JWT bearer + Arabic-friendly error surface.
import { formatILS } from '@medad/shared-types';

let accessToken = localStorage.getItem('medad_token') ?? '';
let refreshToken = localStorage.getItem('medad_refresh') ?? '';

// ─── تتبع التحميل العام (لإظهار لودر عند أي طلب) ───
type LoadingListener = (pending: number) => void;
let pendingCount = 0;
const loadingListeners = new Set<LoadingListener>();

function setPendingCount(n: number) {
  pendingCount = n;
  loadingListeners.forEach((fn) => fn(pendingCount));
}

export function subscribeLoading(fn: LoadingListener): () => void {
  loadingListeners.add(fn);
  fn(pendingCount);
  return () => {
    loadingListeners.delete(fn);
  };
}

export function getPendingCount(): number {
  return pendingCount;
}

export function setTokens(access: string, refresh?: string) {
  accessToken = access;
  localStorage.setItem('medad_token', access);
  if (refresh) {
    refreshToken = refresh;
    localStorage.setItem('medad_refresh', refresh);
  }
}

export function clearTokens() {
  accessToken = '';
  refreshToken = '';
  localStorage.removeItem('medad_token');
  localStorage.removeItem('medad_refresh');
}

export function hasToken(): boolean {
  return !!accessToken;
}

export async function tryRefresh(): Promise<boolean> {
  if (!refreshToken) return false;
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

// رسائل حالة HTTP بالعربية — تُستخدم عند غياب رسالة واضحة من الخادم
const HTTP_STATUS_AR: Record<number, string> = {
  400: 'طلب غير صالح — تحقق من البيانات المدخلة',
  401: 'انتهت صلاحية الجلسة — يرجى تسجيل الدخول مرة أخرى',
  403: 'ليست لديك صلاحية لتنفيذ هذا الإجراء',
  404: 'العنصر المطلوب غير موجود',
  409: 'تعذر تنفيذ العملية — هناك تعارض في البيانات',
  413: 'حجم البيانات المرسلة كبير جداً',
  422: 'البيانات المرسلة غير صالحة',
  429: 'محاولات كثيرة جداً — انتظر قليلاً ثم أعد المحاولة',
  500: 'حدث خطأ غير متوقع في الخادم — أعد المحاولة',
  502: 'الخادم غير متاح حالياً — حاول بعد قليل',
  503: 'الخدمة غير متاحة حالياً — حاول بعد قليل',
  504: 'انتهت مهلة الاتصال بالخادم — أعد المحاولة',
};

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; retry?: boolean; silent?: boolean } = {},
): Promise<T> {
  const track = !opts.silent;
  if (track) setPendingCount(pendingCount + 1);
  try {
    let res: Response;
    try {
      res = await fetch(`/api${path}`, {
        method: opts.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      throw new Error('تعذر الاتصال بالخادم — تحقق من اتصالك بالإنترنت ثم أعد المحاولة');
    }
    if (res.status === 401 && !opts.retry && (await tryRefresh())) {
      return api<T>(path, { ...opts, retry: true, silent: opts.silent });
    }
    if (!res.ok) {
      // 5xx: رسالة الخادم تقنية وغير مفيدة للمستخدم — نعرض رسالة عربية واضحة
      let msg = HTTP_STATUS_AR[res.status] ?? `تعذر إتمام العملية (رمز الخطأ: ${res.status})`;
      if (res.status < 500) {
        try {
          const data = await res.json();
          const m = data?.message;
          if (typeof m === 'string' && m.trim()) msg = m;
          else if (Array.isArray(m) && m.length) msg = m.join('، ');
        } catch { /* keep default */ }
      }
      throw new Error(msg);
    }
    return (await res.json()) as T;
  } finally {
    if (track) setPendingCount(Math.max(0, pendingCount - 1));
  }
}

export const money = formatILS;

/** تنزيل ملف ثنائي (ZIP): Authorization + tryRefresh، ثم حفظ عبر <a download>. */
export async function downloadApi(path: string, fallbackName: string): Promise<void> {
  setPendingCount(pendingCount + 1);
  try {
    const doFetch = () =>
      fetch(`/api${path}`, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } });
    let res: Response;
    try {
      res = await doFetch();
    } catch {
      throw new Error('تعذر الاتصال بالخادم — تحقق من اتصالك بالإنترنت ثم أعد المحاولة');
    }
    if (res.status === 401 && (await tryRefresh())) {
      res = await doFetch();
    }
    if (!res.ok) {
      let msg = HTTP_STATUS_AR[res.status] ?? `تعذر إتمام العملية (رمز الخطأ: ${res.status})`;
      if (res.status < 500) {
        try {
          const data = await res.clone().json();
          const m = data?.message;
          if (typeof m === 'string' && m.trim()) msg = m;
          else if (Array.isArray(m) && m.length) msg = m.join('، ');
        } catch { /* keep default */ }
      }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const disp = res.headers.get('Content-Disposition') ?? '';
    const m = /filename="?([^";]+)"?/.exec(disp);
    const name = m?.[1] ?? fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    setPendingCount(Math.max(0, pendingCount - 1));
  }
}

/** رفع multipart (FormData): بدون Content-Type يدوي، مع Authorization + tryRefresh، يرجع JSON. */
export async function uploadApi<T = unknown>(path: string, form: FormData, retry = false): Promise<T> {
  setPendingCount(pendingCount + 1);
  try {
    let res: Response;
    try {
      res = await fetch(`/api${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      });
    } catch {
      throw new Error('تعذر الاتصال بالخادم — تحقق من اتصالك بالإنترنت ثم أعد المحاولة');
    }
    if (res.status === 401 && !retry && (await tryRefresh())) {
      setPendingCount(Math.max(0, pendingCount - 1));
      return uploadApi<T>(path, form, true);
    }
    if (!res.ok) {
      let msg = HTTP_STATUS_AR[res.status] ?? `تعذر إتمام العملية (رمز الخطأ: ${res.status})`;
      if (res.status < 500) {
        try {
          const data = await res.json();
          const mm = data?.message;
          if (typeof mm === 'string' && mm.trim()) msg = mm;
          else if (Array.isArray(mm) && mm.length) msg = mm.join('، ');
        } catch { /* keep default */ }
      }
      throw new Error(msg);
    }
    return (await res.json()) as T;
  } finally {
    setPendingCount(Math.max(0, pendingCount - 1));
  }
}

/** Send a read-audit event (view/search/print §7) — best effort. */
export function auditEvent(action: string, entity: string, entityId?: string): void {
  void api('/audit/event', { method: 'POST', body: { action, entity, entityId }, silent: true }).catch(() => undefined);
}
