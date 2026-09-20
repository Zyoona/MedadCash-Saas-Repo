import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, auditEvent, money } from '../api.js';
import { Badge, Field, Money } from '../ui.js';
import { usePaySources } from '../banks.js';

// صفحة تفاصيل فاتورة شراء — قراءة فقط.
// ترتيب الحساب الملزم نفسه في الخادم: خصم السطر ← توزيع خصم الفاتورة بالتناسب ← الضريبة بعد الخصومات.

interface DetailLine {
  id: string; variantId: string; qty: number; unitCostAgora: number; lineDiscountAgora: number;
  variant: { id: string; name: string; barcode: string | null; product: { id: string; name: string } } | null;
}
interface PurchaseDetail {
  id: string; status: string; refNo: string | null; notes: string | null; createdAt: string;
  discountAgora: number; taxRateBps: number; taxAgora: number;
  supplier: { id: string; name: string };
  branch: { id: string; name: string };
  lines: DetailLine[];
  payments: { id: string; accountCode: string; amountAgora: number; createdAt: string }[];
}

const STATUS_AR: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  received: { label: 'مستلمة', tone: 'ok' },
  pending: { label: 'معلقة', tone: 'warn' },
  ordered: { label: 'طلبية', tone: 'warn' },
};

const dtShort = (iso: string) => new Date(iso).toLocaleString('ar', { dateStyle: 'short', timeStyle: 'short' });

/** توزيع مبلغ على أوزان بالتناسب (largest remainder) — مطابق للخادم */
function allocateProRata(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w * total) / sum);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = total - floors.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors;
}

interface ComputedLine { grossAgora: number; afterLineAgora: number; discountShareAgora: number; taxableAgora: number; taxAgora: number; netUnitCostAgora: number }

function computeLines(lines: DetailLine[], discountAgora: number, taxRateBps: number) {
  const gross = lines.map((l) => l.qty * l.unitCostAgora);
  const afterLine = lines.map((l, i) => Math.max(0, gross[i] - l.lineDiscountAgora));
  const subtotal = afterLine.reduce((s, x) => s + x, 0);
  const shares = allocateProRata(Math.min(discountAgora, subtotal), afterLine);
  const rows: ComputedLine[] = lines.map((l, i) => {
    const taxable = afterLine[i] - shares[i];
    const tax = Math.round((taxable * taxRateBps) / 10000);
    return { grossAgora: gross[i], afterLineAgora: afterLine[i], discountShareAgora: shares[i], taxableAgora: taxable, taxAgora: tax, netUnitCostAgora: l.qty > 0 ? Math.floor(taxable / l.qty) : 0 };
  });
  const inventoryTotal = rows.reduce((s, r) => s + r.taxableAgora, 0);
  const taxTotal = rows.reduce((s, r) => s + r.taxAgora, 0);
  return { rows, inventoryTotalAgora: inventoryTotal, taxTotalAgora: taxTotal, grandTotalAgora: inventoryTotal + taxTotal };
}

export function PurchaseDetails() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { sources } = usePaySources(true);
  const [detail, setDetail] = useState<PurchaseDetail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setFailed(null);
    api<PurchaseDetail>(`/purchases/${id}`)
      .then((d) => { if (alive) { setDetail(d); auditEvent('view', 'purchases', id); } })
      .catch((e) => { if (alive) setFailed((e as Error).message); });
    return () => { alive = false; };
  }, [id, nonce]);

  const totals = useMemo(
    () => (detail ? computeLines(detail.lines, detail.discountAgora, detail.taxRateBps) : null),
    [detail],
  );

  if (failed) {
    return (
      <div className="card full">
        <h2>تفاصيل فاتورة الشراء</h2>
        <p className="alert">{failed}</p>
        <button className="btn secondary" onClick={() => navigate('/purchases')}>رجوع إلى المشتريات</button>
      </div>
    );
  }
  if (!detail || !totals) {
    return <div className="card full"><p className="muted">جارٍ التحميل...</p></div>;
  }

  const st = STATUS_AR[detail.status] ?? { label: detail.status, tone: 'warn' as const };
  const paid = detail.payments.reduce((s, p) => s + p.amountAgora, 0);
  const remainder = totals.grandTotalAgora - paid;
  const sourceLabel = (code: string) => sources.find((s) => s.code === code)?.label ?? code;

  return (
    <div className="card full" id="purchase-print-area">
      <div className="row-between no-print">
        <h2>فاتورة شراء — {detail.refNo ?? detail.id.slice(0, 8)}</h2>
        <div className="actions">
          <button className="btn secondary" onClick={() => navigate('/purchases')}>رجوع</button>
          <button className="btn secondary" onClick={() => setNonce((n) => n + 1)}>تحديث</button>
          <button className="btn secondary" onClick={() => window.print()}>طباعة</button>
        </div>
      </div>
      <div className="row2">
        <Field label="الحالة"><Badge tone={st.tone}>{st.label}</Badge></Field>
        <Field label="التاريخ"><input value={dtShort(detail.createdAt)} readOnly /></Field>
        <Field label="المورد"><input value={detail.supplier.name} readOnly /></Field>
        <Field label="الفرع"><input value={detail.branch.name} readOnly /></Field>
        <Field label="المرجع"><input value={detail.refNo ?? '—'} readOnly /></Field>
        <Field label="ملاحظات"><input value={detail.notes ?? '—'} readOnly /></Field>
      </div>

      <h3>الأسطر</h3>
      <div className="table-scroll">
      <table className="grid">
        <thead>
          <tr><th>#</th><th>الصنف</th><th>الباركود</th><th>كمية</th><th>تكلفة الوحدة</th><th>خصم السطر</th><th>حصة خصم الفاتورة</th><th>الخاضع للضريبة</th><th>الضريبة</th><th>تكلفة الوحدة الصافية</th></tr>
        </thead>
        <tbody>
          {detail.lines.map((l, i) => {
            const c = totals.rows[i];
            return (
              <tr key={l.id}>
                <td>{i + 1}</td>
                <td>{l.variant ? `${l.variant.product.name} — ${l.variant.name}` : l.variantId.slice(0, 8)}</td>
                <td className="mono">{l.variant?.barcode ?? '—'}</td>
                <td>{l.qty}</td>
                <td><Money agora={l.unitCostAgora} /></td>
                <td><Money agora={l.lineDiscountAgora} /></td>
                <td><Money agora={c.discountShareAgora} /></td>
                <td><Money agora={c.taxableAgora} /></td>
                <td><Money agora={c.taxAgora} /></td>
                <td><Money agora={c.netUnitCostAgora} /></td>
              </tr>
            );
          })}
          {detail.lines.length === 0 && <tr><td colSpan={10}>لا توجد أسطر</td></tr>}
        </tbody>
      </table>
      </div>

      <div className="purchase-totals">
        <div><span>خصم فاتورة</span><Money agora={detail.discountAgora} /></div>
        <div><span>إجمالي المخزون (قبل الضريبة)</span><Money agora={totals.inventoryTotalAgora} /></div>
        <div><span>الضريبة ({detail.taxRateBps / 100}%)</span><Money agora={totals.taxTotalAgora} /></div>
        <div className="grand"><span>الإجمالي</span><Money agora={totals.grandTotalAgora} className="grand" /></div>
        <div><span>المدفوع</span><Money agora={paid} /></div>
        <div><span>{remainder > 0 ? 'ذمة (آجل)' : 'الباقي'}</span><Money agora={Math.max(0, remainder)} /></div>
      </div>

      <h3>الدفعات</h3>
      <table className="grid">
        <thead><tr><th>الحساب</th><th>المبلغ</th><th>التاريخ</th></tr></thead>
        <tbody>
          {detail.payments.map((p) => (
            <tr key={p.id}>
              <td>{sourceLabel(p.accountCode)} <span className="mono">({p.accountCode})</span></td>
              <td><Money agora={p.amountAgora} /></td>
              <td>{dtShort(p.createdAt)}</td>
            </tr>
          ))}
          {detail.payments.length === 0 && <tr><td colSpan={3}>لا دفعات — {detail.status === 'received' ? 'فاتورة آجلة بالكامل' : 'لم تُستلم بعد'}</td></tr>}
        </tbody>
      </table>
      <p className="muted">الأثر المخزني والمحاسبي يُسجل عند الاستلام فقط — الذمة تُقيد تلقائياً على المورد.</p>
      <p className="muted no-print">رمز الفاتورة: <span className="mono">{detail.id}</span> — الإجمالي {money(totals.grandTotalAgora)}</p>
    </div>
  );
}
