import { useEffect, useMemo, useState } from 'react';
import { api, auditEvent, money } from '../api.js';
import { Badge, CsvButton, Field, Modal, Money, Tabs, useToast } from '../ui.js';

interface InvoiceRow {
  id: string; branchId: string; refNo: string | null; status: string; invoiceDiscountAgora: number; createdAt: string;
  customer: { id: string; name: string };
  lines: { netAgora: number; qty: number }[];
  payments: { method: string; accountCode: string; amountAgora: number }[];
  totalAgora: number;
}
interface InvoiceList { total: number; page: number; pageSize: number; rows: InvoiceRow[] }

interface InvoiceLineFull {
  id: string; qty: number; unitPriceAgora: number; lineDiscountAgora: number; invoiceDiscountShareAgora: number;
  taxRateBps: number; taxAgora: number; netAgora: number; variantId: string | null; productId: string | null;
  variant?: { id: string; name: string; barcode: string | null; product?: { id: string; name: string } } | null;
}
interface InvoiceDetail {
  id: string; refNo: string | null; status: string; invoiceDiscountAgora: number; createdAt: string;
  customer: { id: string; name: string }; branch: { id: string; name: string };
  shift: { id: string; openedAt: string } | null;
  lines: InvoiceLineFull[];
  payments: { id: string; method: string; accountCode: string; amountAgora: number }[];
  returned: { variantId: string; qty: number }[];
  totalAgora: number;
}

interface ReturnRow {
  id: string; sourceInvoiceId: string; restockingFeeAgora: number; refundMethod: string; refundAccountCode: string; createdAt: string;
  lines: { variantId: string; qty: number }[];
}

const METHOD_AR: Record<string, string> = { cash: 'نقد', bank: 'بنك', check: 'شيك', credit: 'ذمة (آجل)' };

const STATUS_AR: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  posted: { label: 'مُسجلة', tone: 'ok' },
  draft: { label: 'مسودة', tone: 'warn' },
  void: { label: 'ملغاة', tone: 'bad' },
};

const PAGE_SIZE = 25;
const dtShort = (iso: string) => new Date(iso).toLocaleString('ar', { dateStyle: 'short', timeStyle: 'short' });
const paySummary = (payments: { method: string; amountAgora: number }[]) =>
  payments.length === 0 ? 'ذمة' : payments.map((p) => `${METHOD_AR[p.method] ?? p.method} ${money(p.amountAgora)}`).join(' + ');

export function Sales() {
  const [tab, setTab] = useState('invoices');
  const [toast, showToast] = useToast();
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [branchId, setBranchId] = useState('');

  useEffect(() => {
    api<{ id: string; name: string }[]>('/org/branches').then(setBranches).catch(() => undefined);
    auditEvent('view', 'sales');
  }, []);

  return (
    <div className="card">
      {toast}
      <h2>المبيعات</h2>
      <p className="muted">سجل للقراءة فقط — الفواتير غير قابلة للتعديل، والتصحيح عبر مرتجع بيع من شاشة الكاشير</p>
      <div className="row2">
        <Field label="الفرع">
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">كل الفروع</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
      </div>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[{ id: 'invoices', label: 'الفواتير' }, { id: 'returns', label: 'المرتجعات' }]}
      />
      {tab === 'invoices' && <InvoicesTab branchId={branchId} branches={branches} showToast={showToast} />}
      {tab === 'returns' && <ReturnsTab branchId={branchId} showToast={showToast} />}
    </div>
  );
}

function InvoicesTab({ branchId, branches, showToast }: {
  branchId: string; branches: { id: string; name: string }[]; showToast: (m: string, t?: 'ok' | 'bad') => void;
}) {
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [refInput, setRefInput] = useState('');
  const [ref, setRef] = useState('');
  const [page, setPage] = useState(1);
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<InvoiceList | null>(null);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);

  useEffect(() => {
    api<{ id: string; name: string }[]>('/parties/customers').then(setCustomers).catch(() => undefined);
  }, []);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (branchId) p.set('branchId', branchId);
    if (customerId) p.set('customerId', customerId);
    if (from) p.set('from', from);
    if (to) p.set('to', `${to}T23:59:59.999`);
    if (ref.trim()) p.set('refNo', ref.trim());
    p.set('page', String(page));
    p.set('pageSize', String(PAGE_SIZE));
    return p.toString();
  }, [branchId, customerId, from, to, ref, page]);

  useEffect(() => {
    api<InvoiceList>(`/sales/invoices?${query}`)
      .then(setData)
      .catch((e) => showToast((e as Error).message, 'bad'));
  }, [query, nonce]);

  const resetPage = () => setPage(1);
  const applyRef = () => { resetPage(); setRef(refInput); };
  const reload = () => setNonce((n) => n + 1);

  const openDetail = async (id: string) => {
    try {
      const d = await api<InvoiceDetail>(`/sales/invoices/${id}`);
      auditEvent('view', 'invoices', id);
      setDetail(d);
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const csvRows = (data?.rows ?? []).map((r) => ({
    التاريخ: dtShort(r.createdAt),
    المرجع: r.refNo ?? r.id.slice(0, 8),
    الزبون: r.customer.name,
    الأسطر: r.lines.length,
    الإجمالي: money(r.totalAgora),
    الدفع: paySummary(r.payments),
  }));

  return (
    <div>
      <div className="row2">
        <Field label="الزبون">
          <select value={customerId} onChange={(e) => { resetPage(); setCustomerId(e.target.value); }}>
            <option value="">كل الزبائن</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="من تاريخ"><input type="date" value={from} onChange={(e) => { resetPage(); setFrom(e.target.value); }} /></Field>
        <Field label="إلى تاريخ"><input type="date" value={to} onChange={(e) => { resetPage(); setTo(e.target.value); }} /></Field>
        <Field label="المرجع">
          <input
            placeholder="بحث برقم الفاتورة"
            value={refInput}
            onChange={(e) => setRefInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyRef(); }}
          />
        </Field>
        <button className="btn secondary" onClick={applyRef}>بحث</button>
        <CsvButton filename="sales_invoices.csv" rows={csvRows} />
      </div>
      <table className="grid">
        <thead>
          <tr><th>التاريخ</th><th>المرجع</th><th>الزبون</th><th>الفرع</th><th>أسطر</th><th>الإجمالي</th><th>الدفع</th><th>الحالة</th><th></th></tr>
        </thead>
        <tbody>
          {(data?.rows ?? []).map((r) => {
            const st = STATUS_AR[r.status] ?? { label: r.status, tone: 'warn' as const };
            return (
              <tr key={r.id}>
                <td>{dtShort(r.createdAt)}</td>
                <td className="mono">{r.refNo ?? r.id.slice(0, 8)}</td>
                <td>{r.customer.name}</td>
                <td>{branches.find((b) => b.id === r.branchId)?.name ?? '—'}</td>
                <td>{r.lines.length}</td>
                <td><Money agora={r.totalAgora} /></td>
                <td>{paySummary(r.payments)}</td>
                <td><Badge tone={st.tone}>{st.label}</Badge></td>
                <td className="actions">
                  <button className="btn secondary small" onClick={() => void openDetail(r.id)}>تفاصيل</button>
                </td>
              </tr>
            );
          })}
          {data && data.rows.length === 0 && <tr><td colSpan={9}>لا توجد فواتير في النطاق المحدد</td></tr>}
          {!data && <tr><td colSpan={9}>جارٍ التحميل...</td></tr>}
        </tbody>
      </table>
      <div className="row-between">
        <span className="muted">{data ? `الإجمالي: ${data.total} فاتورة — صفحة ${page} من ${pages}` : ''}</span>
        <div className="actions">
          <button className="btn secondary small" disabled={page <= 1} onClick={() => setPage(page - 1)}>السابق</button>
          <button className="btn secondary small" disabled={page >= pages} onClick={() => setPage(page + 1)}>التالي</button>
          <button className="btn secondary small" onClick={reload}>تحديث</button>
        </div>
      </div>
      {detail && <InvoiceDetailModal detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function InvoiceDetailModal({ detail, onClose }: { detail: InvoiceDetail; onClose: () => void }) {
  const paidNet = detail.payments.reduce((s, p) => s + p.amountAgora, 0);
  const remainder = detail.totalAgora - paidNet;
  const returnedQty = detail.returned.reduce((s, r) => s + r.qty, 0);

  return (
    <Modal title={`فاتورة ${detail.refNo ?? detail.id.slice(0, 8)}`} onClose={onClose}>
      <div className="row2">
        <Field label="التاريخ"><input value={dtShort(detail.createdAt)} readOnly /></Field>
        <Field label="الزبون"><input value={detail.customer.name} readOnly /></Field>
        <Field label="الفرع"><input value={detail.branch.name} readOnly /></Field>
        <Field label="الوردية"><input value={detail.shift ? dtShort(detail.shift.openedAt) : '—'} readOnly /></Field>
      </div>
      <table className="grid">
        <thead>
          <tr><th>الصنف</th><th>الباركود</th><th>كمية</th><th>سعر</th><th>خصم المنتج</th><th>حصة خصم فاتورة</th><th>ضريبة</th><th>الصافي</th><th>مرتجع</th></tr>
        </thead>
        <tbody>
          {detail.lines.map((l) => {
            const vid = l.variantId ?? l.productId ?? l.id;
            const prev = detail.returned.find((r) => r.variantId === vid)?.qty ?? 0;
            return (
              <tr key={l.id}>
                <td>{l.variant ? `${l.variant.product?.name ?? ''} — ${l.variant.name}` : l.productId ?? '—'}</td>
                <td className="mono">{l.variant?.barcode ?? '—'}</td>
                <td>{l.qty}</td>
                <td><Money agora={l.unitPriceAgora} /></td>
                <td><Money agora={l.lineDiscountAgora} /></td>
                <td><Money agora={l.invoiceDiscountShareAgora} /></td>
                <td><Money agora={l.taxAgora} /></td>
                <td><Money agora={l.netAgora} /></td>
                <td>{prev > 0 ? <Badge tone="warn">{prev}</Badge> : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="totals">
        <div><span>الإجمالي</span><Money agora={detail.totalAgora} className="grand" /></div>
        <div><span>المدفوع</span><Money agora={paidNet} /></div>
        <div><span>{remainder > 0 ? 'ذمة (آجل)' : 'الباقي'}</span><Money agora={Math.abs(remainder)} /></div>
        {returnedQty > 0 && <div><span>كميات مرتجعة</span><span>{returnedQty}</span></div>}
      </div>
      <h4>الدفعات</h4>
      <table className="grid">
        <thead><tr><th>الطريقة</th><th>الحساب</th><th>المبلغ</th></tr></thead>
        <tbody>
          {detail.payments.map((p) => (
            <tr key={p.id}>
              <td>{METHOD_AR[p.method] ?? p.method}{p.amountAgora < 0 ? ' (إرجاع باقي)' : ''}</td>
              <td className="mono">{p.accountCode}</td>
              <td><Money agora={p.amountAgora} /></td>
            </tr>
          ))}
          {detail.payments.length === 0 && <tr><td colSpan={3}>لا دفعات — فاتورة آجلة</td></tr>}
        </tbody>
      </table>
    </Modal>
  );
}

function ReturnsTab({ branchId, showToast }: { branchId: string; showToast: (m: string, t?: 'ok' | 'bad') => void }) {
  const [rows, setRows] = useState<ReturnRow[] | null>(null);

  useEffect(() => {
    api<ReturnRow[]>(`/sales/returns${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`)
      .then(setRows)
      .catch((e) => showToast((e as Error).message, 'bad'));
  }, [branchId]);

  return (
    <div>
      <table className="grid">
        <thead><tr><th>التاريخ</th><th>فاتورة المصدر</th><th>عدد القطع</th><th>طريقة الرد</th><th>رسوم إرجاع</th></tr></thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.id}>
              <td>{dtShort(r.createdAt)}</td>
              <td className="mono">{r.sourceInvoiceId.slice(0, 8)}</td>
              <td>{r.lines.reduce((s, l) => s + l.qty, 0)}</td>
              <td>{METHOD_AR[r.refundMethod] ?? r.refundMethod}</td>
              <td><Money agora={r.restockingFeeAgora} /></td>
            </tr>
          ))}
          {rows && rows.length === 0 && <tr><td colSpan={5}>لا توجد مرتجعات مسجلة</td></tr>}
          {!rows && <tr><td colSpan={5}>جارٍ التحميل...</td></tr>}
        </tbody>
      </table>
      <p className="muted">أحدث 200 سجل</p>
    </div>
  );
}
