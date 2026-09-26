import { useEffect, useMemo, useState } from 'react';
import { api, auditEvent, money } from '../api.js';
import { downloadCsv, Field, Money } from '../ui.js';
import { PageLoader } from '../Loader.js';

// التقارير — تقرير الربح لأي فترة (من → إلى) بلغة بسيطة لغير المحاسبين:
// صافي الربح = المبيعات − تكلفة البضاعة التي بيعت − المصروفات الأخرى.
// الأرقام من دفتر القيود (GET /reports/profit) — نفس مصدر إقفال السنة المالية.

interface ProfitReport {
  from: string;
  to: string;
  salesAgora: number;
  cogsAgora: number;
  grossProfitAgora: number;
  grossMarginPct: number | null;
  expenses: { code: string; name: string; amountAgora: number }[];
  expensesTotalAgora: number;
  netProfitAgora: number;
  netMarginPct: number | null;
  invoicesCount: number;
  invoicesTotalAgora: number;
  avgInvoiceAgora: number;
  returnsCount: number;
  byDay: { date: string; revenueAgora: number; costsAgora: number; profitAgora: number }[];
  topItems: { name: string; qty: number; revenueAgora: number; costAgora: number; profitAgora: number }[];
}

type Preset = 'today' | 'yesterday' | '7d' | 'month' | 'lastMonth' | 'year' | 'custom';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function rangeOf(p: Preset): { from: string; to: string } | null {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (p) {
    case 'today': return { from: iso(today), to: iso(today) };
    case 'yesterday': { const d = new Date(y, m, today.getDate() - 1); return { from: iso(d), to: iso(d) }; }
    case '7d': return { from: iso(new Date(y, m, today.getDate() - 6)), to: iso(today) };
    case 'month': return { from: iso(new Date(y, m, 1)), to: iso(today) };
    case 'lastMonth': return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case 'year': return { from: `${y}-01-01`, to: iso(today) };
    default: return null;
  }
}

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'today', label: 'اليوم' },
  { id: 'yesterday', label: 'أمس' },
  { id: '7d', label: 'آخر 7 أيام' },
  { id: 'month', label: 'هذا الشهر' },
  { id: 'lastMonth', label: 'الشهر الماضي' },
  { id: 'year', label: 'هذا العام' },
  { id: 'custom', label: 'فترة مخصصة' },
];

const fmtDay = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString('ar', { day: 'numeric', month: 'short' });

export function Reports() {
  const [preset, setPreset] = useState<Preset>('month');
  const init = rangeOf('month')!;
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const [branchId, setBranchId] = useState('');
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [data, setData] = useState<ProfitReport | null>(null);
  const [err, setErr] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    api<{ id: string; name: string }[]>('/org/branches').then(setBranches).catch(() => undefined);
    auditEvent('view', 'reports');
  }, []);

  const applyPreset = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') {
      const r = rangeOf(p)!;
      setFrom(r.from);
      setTo(r.to);
      setNonce((n) => n + 1);
    }
  };

  const query = useMemo(() => {
    const p = new URLSearchParams();
    p.set('from', `${from}T00:00:00.000`);
    p.set('to', `${to}T23:59:59.999`);
    if (branchId) p.set('branchId', branchId);
    return p.toString();
  }, [from, to, branchId]);

  useEffect(() => {
    setErr('');
    api<ProfitReport>(`/reports/profit?${query}`)
      .then(setData)
      .catch((e) => setErr((e as Error).message));
  }, [query, nonce]);

  const periodText = useMemo(
    () => `${fmtDay(from)} ← ${fmtDay(to)}`,
    [from, to],
  );

  // الرسم: يومي حتى 62 نقطة، وإلا تجميع شهري حتى تبقى الأعمدة مقروءة
  const chart = useMemo(() => {
    if (!data) return [];
    const rows = data.byDay;
    if (rows.length <= 62) return rows.map((r) => ({ label: fmtDay(r.date), revenueAgora: r.revenueAgora, profitAgora: r.profitAgora }));
    const byMonth = new Map<string, { revenueAgora: number; profitAgora: number }>();
    for (const r of rows) {
      const k = r.date.slice(0, 7);
      const g = byMonth.get(k) ?? { revenueAgora: 0, profitAgora: 0 };
      g.revenueAgora += r.revenueAgora;
      g.profitAgora += r.profitAgora;
      byMonth.set(k, g);
    }
    return [...byMonth.entries()].map(([k, v]) => ({ label: k, ...v }));
  }, [data]);
  const chartMonthly = !!data && data.byDay.length > 62;
  const chartMax = Math.max(1, ...chart.map((c) => Math.abs(c.profitAgora)));

  const empty = data && data.byDay.length === 0 && data.invoicesCount === 0 && data.expenses.length === 0;

  const flow: { title: string; amount: number; sub: string; kind: 'in' | 'out' | 'total' }[] = data
    ? [
        { title: 'المبيعات', amount: data.salesAgora, sub: 'ما بيعتَه خلال الفترة (بدون الضريبة)', kind: 'in' },
        { title: 'تكلفة البضاعة المبيعة', amount: -data.cogsAgora, sub: 'ما كلّفك شراء البضاعة التي بيعت فعلاً', kind: 'out' },
        { title: 'الربح قبل المصروفات', amount: data.grossProfitAgora, sub: 'المبيعات − تكلفة البضاعة المبيعة', kind: 'total' },
        { title: 'المصروفات الأخرى', amount: -data.expensesTotalAgora, sub: 'فروقات الجرد والصندوق وأي مصروفات أخرى مسجلة', kind: 'out' },
        { title: 'صافي الربح', amount: data.netProfitAgora, sub: 'النتيجة النهائية للفترة', kind: 'total' },
      ]
    : [];

  return (
    <div className="card full">
      <div className="row-between">
        <h2>التقارير — الربح</h2>
        <button className="btn secondary" onClick={() => setNonce((n) => n + 1)}>تحديث</button>
      </div>

      <div className="tabs" role="group" aria-label="الفترة">
        {PRESETS.map((p) => (
          <button key={p.id} className={p.id === preset ? 'tab active' : 'tab'} onClick={() => applyPreset(p.id)}>{p.label}</button>
        ))}
      </div>

      <div className="row2 wrap">
        <Field label="من تاريخ">
          <input type="date" value={from} onChange={(e) => { setPreset('custom'); setFrom(e.target.value); }} />
        </Field>
        <Field label="إلى تاريخ">
          <input type="date" value={to} onChange={(e) => { setPreset('custom'); setTo(e.target.value); }} />
        </Field>
        <Field label="الفرع">
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">كل الفروع</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <button
          className="btn secondary"
          disabled={!data || data.byDay.length === 0}
          onClick={() => data && downloadCsv('profit_daily.csv', data.byDay.map((r) => ({
            التاريخ: r.date,
            المبيعات: r.revenueAgora / 100,
            'التكلفة والمصروفات': r.costsAgora / 100,
            الربح: r.profitAgora / 100,
          })))}
        >تصدير يومي CSV</button>
        <button
          className="btn secondary"
          disabled={!data || data.topItems.length === 0}
          onClick={() => data && downloadCsv('profit_items.csv', data.topItems.map((t) => ({
            الصنف: t.name,
            الكمية: t.qty,
            المبيعات: t.revenueAgora / 100,
            التكلفة: t.costAgora / 100,
            الربح: t.profitAgora / 100,
          })))}
        >تصدير الأصناف CSV</button>
      </div>

      {err && <div className="alert bad">{err}</div>}
      {!data && !err && <PageLoader />}
      {data && (
        <>
          <div className={`rpt-hero ${data.netProfitAgora < 0 ? 'neg' : 'pos'}`}>
            <div>
              <div className="rpt-hero-label">صافي الربح خلال الفترة</div>
              <div className="rpt-hero-value">{money(data.netProfitAgora)}</div>
              <div className="rpt-hero-sub">{periodText}{data.netMarginPct !== null ? ` — هامش ${data.netMarginPct}%` : ''}</div>
            </div>
            {data.invoicesCount > 0 && (
              <div className="rpt-hero-side">
                <span>{data.invoicesCount} فاتورة</span>
                <span>متوسط الفاتورة {money(data.avgInvoiceAgora)}</span>
              </div>
            )}
          </div>

          {empty && <div className="alert ok-alert">لا توجد حركات مسجلة في هذه الفترة — جرّب فترة أوسع.</div>}

          <h4>كيف جاء هذا الربح؟</h4>
          <div className="rpt-flow">
            {flow.map((f) => (
              <div key={f.title} className={`rpt-flow-row ${f.kind}${f.kind === 'total' && f.amount < 0 ? ' neg-total' : ''}`}>
                <div>
                  <div className="t">{f.title}</div>
                  <div className="sub">{f.sub}</div>
                </div>
                <div className={`v ${f.kind !== 'total' && f.amount < 0 ? 'rpt-neg' : ''}`}>
                  {f.kind !== 'total' ? `${f.amount < 0 ? '−' : f.amount > 0 ? '+' : ''} ` : ''}
                  {f.kind === 'total' ? <Money agora={f.amount} /> : <Money agora={Math.abs(f.amount)} />}
                </div>
              </div>
            ))}
          </div>

          {chart.length > 0 && (
            <>
              <h4>الربح عبر الفترة {chartMonthly ? '(شهرياً)' : '(يومياً)'}</h4>
              <div className="rpt-chart" role="img" aria-label="رسم بياني للربح">
                {chart.map((c) => (
                  <div
                    key={c.label}
                    className="rpt-col"
                    title={`${c.label} — الربح ${money(c.profitAgora)} (مبيعات ${money(c.revenueAgora)})`}
                  >
                    <div
                      className={`rpt-bar ${c.profitAgora < 0 ? 'neg' : 'pos'}`}
                      style={{ height: `${Math.max(2, Math.round((Math.abs(c.profitAgora) / chartMax) * 100))}%` }}
                    />
                  </div>
                ))}
              </div>
              <div className="rpt-legend">
                <span><i className="rpt-dot pos" /> ربح</span>
                <span><i className="rpt-dot neg" /> خسارة</span>
                <span className="muted">مرّر المؤشر فوق أي عمود لعرض الأرقام</span>
              </div>
            </>
          )}

          <div className="rpt-grid">
            <div>
              <h4>المصروفات الأخرى</h4>
              <table className="grid">
                <thead><tr><th>البند</th><th>المبلغ</th></tr></thead>
                <tbody>
                  {data.expenses.length === 0 && <tr><td colSpan={2}>لا مصروفات أخرى في هذه الفترة</td></tr>}
                  {data.expenses.map((e) => (
                    <tr key={e.code}>
                      <td>{e.name}<small className="muted mono"> {e.code}</small></td>
                      <td className={e.amountAgora < 0 ? 'rpt-neg' : ''}><Money agora={e.amountAgora} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.expenses.some((e) => e.amountAgora < 0) && (
                <p className="muted">المبالغ السالبة تعني فائضاً أو عائداً يقلّل المصروفات (مثل فائض صندوق).</p>
              )}
            </div>
            <div>
              <h4>أكثر الأصناف ربحاً</h4>
              <table className="grid">
                <thead><tr><th>الصنف</th><th>الكمية</th><th>الربح</th></tr></thead>
                <tbody>
                  {data.topItems.length === 0 && <tr><td colSpan={3}>لا مبيعات في هذه الفترة</td></tr>}
                  {data.topItems.map((t) => (
                    <tr key={t.name}>
                      <td title={`مبيعات ${money(t.revenueAgora)} — تكلفة ${money(t.costAgora)}`}>{t.name}</td>
                      <td>{t.qty}</td>
                      <td className={t.profitAgora < 0 ? 'rpt-neg' : 'rpt-pos'}><Money agora={t.profitAgora} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.returnsCount > 0 && <p className="muted">سُجّلت {data.returnsCount} مرتجع بيع خلال الفترة — أثرها مخصوم من المبيعات والتكلفة أعلاه.</p>}
            </div>
          </div>

          <details className="rpt-how">
            <summary>كيف يُحسب هذا التقرير؟</summary>
            <ul>
              <li>صافي الربح = المبيعات − تكلفة البضاعة التي بيعت فعلاً − باقي المصروفات.</li>
              <li>الضريبة غير محسوبة ضمن الربح لأنها واجبة السداد وليست إيراداً.</li>
              <li>المصدر هو دفتر القيود نفسه الذي يُبنى عليه إقفال السنة المالية — يشمل فواتير الكاشير والمرتجعات وأي قيود يدوية.</li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
