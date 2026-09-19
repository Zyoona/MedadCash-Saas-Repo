import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, auditEvent, money } from '../api.js';
import { Badge, useToast } from '../ui.js';
import { PageLoader } from '../Loader.js';
import { useAuth } from '../auth.js';

interface Summary {
  todaySalesAgora: number;
  todayInvoicesCount: number;
  cashAgora: number;
  bankAgora: number;
  banks: { id: string; bankName: string; accountLabel: string | null; glAccountCode: string; isActive: boolean; balanceAgora: number }[];
  receivablesAgora: number;
  payablesAgora: number;
  lowStockCount: number;
  negativeStockCount: number;
  openConflicts: number;
  lastBackup: { status: string; provider: string; startedAt: string } | null;
  openShift: { id: string; openedAt: string; openingAmountAgora: number } | null;
  expiredQuotations: number;
  dueChecks: number;
  trialBalance: { debitAgora: number; creditAgora: number; balanced: boolean };
}

interface Task { id: string; serviceProduct: string; status: string; deadline: string | null; customer: { name: string } | null }

const STATUS_AR: Record<string, string> = { open: 'مفتوحة', in_progress: 'جارية', ready: 'جاهزة للتسليم', delivered: 'سُلمت', cancelled: 'ملغاة' };

function dayDiff(deadline: string): number {
  const dl = new Date(deadline);
  const now = new Date();
  const a = new Date(dl.getFullYear(), dl.getMonth(), dl.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((a - b) / 86400000);
}

const daysWord = (n: number) => (n === 1 ? 'يوم واحد' : n === 2 ? 'يومان' : n <= 10 ? `${n} أيام` : `${n} يوماً`);

function dueBadge(t: Task): { tone: 'ok' | 'warn' | 'bad'; label: string } {
  if (!t.deadline) return { tone: 'warn', label: 'جاهزة — بلا موعد' };
  const d = dayDiff(t.deadline);
  if (d < 0) return { tone: 'bad', label: `متأخرة ${daysWord(-d)}` };
  if (d === 0) return { tone: 'bad', label: 'تسليم اليوم' };
  if (d === 1) return { tone: 'warn', label: 'تسليم غداً' };
  if (d <= 3) return { tone: 'warn', label: `باقي ${daysWord(d)}` };
  return { tone: 'ok', label: `باقي ${daysWord(d)}` };
}

export function Dashboard() {
  const { can } = useAuth();
  const [s, setS] = useState<Summary | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [err, setErr] = useState('');
  const [toast, showToast] = useToast();

  const loadTasks = () => {
    if (!can('tasks.view')) return;
    api<Task[]>('/ops/tasks').then(setTasks).catch(() => setTasks(null));
  };

  const load = () => {
    api<Summary>('/dashboard/summary')
      .then((d) => { setS(d); auditEvent('view', 'dashboard'); })
      .catch((e) => setErr((e as Error).message));
    loadTasks();
  };
  useEffect(load, []);

  if (err) return <div className="card"><div className="alert">{err}</div></div>;
  if (!s) return <div className="card"><PageLoader /></div>;

  const alerts: { tone: 'warn' | 'bad'; text: string }[] = [];
  if (s.openConflicts > 0) alerts.push({ tone: 'bad', text: `${s.openConflicts} تعارض مزامنة ينتظر حلاً يدوياً` });
  if (s.negativeStockCount > 0) alerts.push({ tone: 'warn', text: `${s.negativeStockCount} صنف بمخزون سالب` });
  if (s.expiredQuotations > 0) alerts.push({ tone: 'warn', text: `${s.expiredQuotations} عرض سعر منتهي الصلاحية` });
  if (s.dueChecks > 0) alerts.push({ tone: 'warn', text: `${s.dueChecks} شيك مستحق/متأخر` });
  if (s.lastBackup && s.lastBackup.status !== 'success') alerts.push({ tone: 'bad', text: 'فشل آخر نسخ احتياطي — راجع شاشة المزامنة' });
  if (!s.trialBalance.balanced) alerts.push({ tone: 'bad', text: 'ميزان المراجعة غير متوازن!' });

  const dueTasks = (tasks ?? [])
    .filter((t) => t.status !== 'delivered' && t.status !== 'cancelled')
    .sort((a, b) => {
      if (a.deadline && b.deadline) return dayDiff(a.deadline) - dayDiff(b.deadline);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return 0;
    })
    .slice(0, 6);

  return (
    <div>
      {toast}
      <div className="dash-grid">
      <div className="card">
        <div className="row-between">
          <h2>لوحة اليوم</h2>
          <button className="btn secondary" onClick={load}>تحديث</button>
        </div>
        <div className="kpi-row">
          <div className="kpi"><div className="label">مبيعات اليوم</div><div className="value">{money(s.todaySalesAgora)}</div></div>
          <div className="kpi"><div className="label">فواتير اليوم</div><div className="value">{s.todayInvoicesCount}</div></div>
          <div className="kpi"><div className="label">الصندوق</div><div className="value">{money(s.cashAgora)}</div></div>
          <div className="kpi"><div className="label">البنك</div><div className="value">{money(s.bankAgora)}</div></div>
          <div className="kpi"><div className="label">ذمم العملاء</div><div className="value">{money(s.receivablesAgora)}</div></div>
          <div className="kpi"><div className="label">ذمم الموردين</div><div className="value">{money(s.payablesAgora)}</div></div>
        </div>
        <div className="kpi-row">
          <div className="kpi"><div className="label">النواقص</div><div className="value">{s.lowStockCount}</div></div>
          <div className="kpi"><div className="label">مخزون سالب</div><div className="value">{s.negativeStockCount}</div></div>
          <div className="kpi"><div className="label">تعارضات معلقة</div><div className="value">{s.openConflicts}</div></div>
          <div className="kpi">
            <div className="label">ميزان المراجعة</div>
            <div className="value">
              <Badge tone={s.trialBalance.balanced ? 'ok' : 'bad'}>{s.trialBalance.balanced ? 'متوازن' : 'غير متوازن'}</Badge>
            </div>
          </div>
          <div className="kpi">
            <div className="label">آخر نسخة احتياطية</div>
            <div className="value">
              {s.lastBackup
                ? <><Badge tone={s.lastBackup.status === 'success' ? 'ok' : 'bad'}>{s.lastBackup.provider}</Badge> <small>{new Date(s.lastBackup.startedAt).toLocaleString('ar')}</small></>
                : <Badge tone="warn">لا نسخ بعد</Badge>}
            </div>
          </div>
          <div className="kpi"><div className="label">الوردية الحالية</div><div className="value">{s.openShift ? 'مفتوحة' : 'مغلقة'}</div></div>
        </div>
        {alerts.map((a, i) => <div key={i} className={`alert ${a.tone === 'bad' ? 'bad' : ''}`}>{a.text}</div>)}
        {s.banks.length > 0 && (
          <>
            <h4 style={{ marginTop: 12 }}>الحسابات البنكية</h4>
            <div className="kpi-row">
              {s.banks.map((b) => (
                <div className="kpi" key={b.id}>
                  <div className="label">{b.bankName}{b.accountLabel ? ` — ${b.accountLabel}` : ''}{b.isActive ? '' : ' (معطل)'}</div>
                  <div className="value">{money(b.balanceAgora)}</div>
                  <small className="muted mono">{b.glAccountCode}</small>
                </div>
              ))}
            </div>
          </>
        )}   </div>
      {can('tasks.view') && (
        <div className="card">
          <div className="row-between">
            <h2>تذكير بالتسليم</h2>
            {tasks && <Badge tone="warn">{dueTasks.length}</Badge>}
          </div>
          <p className="muted">أقرب المهام المطلوب تسليمها للزبائن مرتبة حسب الموعد</p>
          {!tasks
            ? <p className="muted">جارٍ تحميل التذكيرات...</p>
            : dueTasks.length === 0
              ? <div className="alert ok-alert">لا توجد مهام قيد التسليم — كل شيء تم تسليمه</div>
              : (
                <ul className="due-list">
                  {dueTasks.map((t) => {
                    const b = dueBadge(t);
                    return (
                      <li className="due-item" key={t.id}>
                        <div className="due-info">
                          <div className="due-title">{t.serviceProduct}</div>
                          <div className="due-meta">
                            {t.customer?.name ?? 'بدون زبون'} · الموعد: {t.deadline ? new Date(t.deadline).toLocaleDateString('ar') : '—'} · {STATUS_AR[t.status] ?? t.status}
                          </div>
                        </div>
                        <Badge tone={b.tone}>{b.label}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
          <Link className="btn secondary wide" to="/tasks">فتح شاشة المهام</Link>
        </div>
      )}
      </div>
    </div>
  );
}
