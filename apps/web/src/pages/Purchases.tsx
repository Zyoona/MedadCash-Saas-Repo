import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toAgora } from '@medad/shared-types';
import { api, auditEvent, money } from '../api.js';
import { Badge, CsvButton, Field, Modal, Money, SplitAgora, useToast } from '../ui.js';
import { usePaySources } from '../banks.js';

interface PurchaseRow {
  id: string; status: string; refNo: string | null; createdAt: string;
  discountAgora: number; taxRateBps: number; taxAgora: number;
  supplier: { id: string; name: string };
  branch: { id: string; name: string } | null;
  lines: { id: string; variantId: string; qty: number; unitCostAgora: number; lineDiscountAgora: number }[];
  payments: { id: string; accountCode: string; amountAgora: number; createdAt: string }[];
  totals: { grandTotalAgora: number; paidAgora: number; remainderAgora: number } | null;
}

const STATUS_AR: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  received: { label: 'مستلمة', tone: 'ok' },
  pending: { label: 'معلقة', tone: 'warn' },
  ordered: { label: 'طلبية', tone: 'warn' },
};

const dtShort = (iso: string) => new Date(iso).toLocaleString('ar', { dateStyle: 'short', timeStyle: 'short' });
/** التاريخ فقط — التاريخ والوقت كاملان يظهران عند المرور (title) لتضييق الجدول */
const dtDate = (iso: string) => new Date(iso).toLocaleDateString('ar', { dateStyle: 'short' });

export function Purchases() {
  const [rows, setRows] = useState<PurchaseRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<{ id: string; ref: string; amount: number; code: string } | null>(null);
  const { sources } = usePaySources(true);
  const [toast, showToast] = useToast();
  const navigate = useNavigate();

  // فلاتر القائمة — تُطبق على الخادم
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    api<{ id: string; name: string }[]>('/parties/suppliers').then(setSuppliers).catch(() => undefined);
    api<{ id: string; name: string }[]>('/org/branches').then(setBranches).catch(() => undefined);
    auditEvent('view', 'purchases');
  }, []);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (supplierId) p.set('supplierId', supplierId);
    if (branchId) p.set('branchId', branchId);
    if (status) p.set('status', status);
    if (from) p.set('from', `${from}T00:00:00.000`);
    if (to) p.set('to', `${to}T23:59:59.999`);
    if (q.trim()) p.set('q', q.trim());
    return p.toString();
  }, [supplierId, branchId, status, from, to, q]);

  const load = () => api<PurchaseRow[]>(`/purchases?${query}`)
    .then((r) => setRows([...r].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))))
    .catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, [query, nonce]);

  const act = async (id: string, st: 'pending' | 'received', payments: { accountCode: string; amountAgora: number }[] = []) => {
    try {
      const res = await api<any>(`/purchases/${id}/status`, { method: 'POST', body: { status: st, payments } });
      showToast(st === 'received' ? `استُلمت — الإجمالي ${money(res.totals.grandTotalAgora)}، ذمة: ${money(res.remainderAgora)}` : 'أُعيدت إلى قيد الانتظار (لم تُستلم بعد)');
      load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const doReceive = async () => {
    if (!receiving) return;
    act(receiving.id, 'received', receiving.amount > 0 ? [{ accountCode: receiving.code, amountAgora: receiving.amount }] : []);
    setReceiving(null);
  };

  // الأحدث أولاً ثم الأقدم (الخادم يرتب كذلك — هذا ترتيب وقائي في العرض)
  const visibleRows = useMemo(
    () => [...(rows ?? [])].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)),
    [rows],
  );

  const toCsvRow = (r: PurchaseRow) => ({
    'تاريخ الإضافة': dtShort(r.createdAt),
    'المرجع': r.refNo ?? r.id.slice(0, 8),
    'المورد': r.supplier.name,
    'الفرع': r.branch?.name ?? '—',
    'الأسطر': r.lines.length,
    'الإجمالي': r.totals ? money(r.totals.grandTotalAgora) : '—',
    'المدفوع': money(r.totals?.paidAgora ?? 0),
    'الذمة': r.status === 'received' && r.totals ? money(r.totals.remainderAgora) : '—',
    'الحالة': STATUS_AR[r.status]?.label ?? r.status,
  });

  return (
    <div className="card full">
      {toast}
      <div className="row-between">
        <h2>المشتريات — الأثر المخزني والمحاسبي عند الاستلام فقط</h2>
        <button className="btn" onClick={() => setCreating(true)}>+ فاتورة شراء</button>
      </div>

      <div className="row2">
        <Field label="المورد">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">كل الموردين</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="الفرع">
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">كل الفروع</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <Field label="الحالة">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">كل الحالات</option>
            <option value="ordered">طلبية</option>
            <option value="pending">معلقة</option>
            <option value="received">مستلمة</option>
          </select>
        </Field>
        <Field label="من تاريخ"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="إلى تاريخ"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="بحث">
          <input
            placeholder="رقم مرجعي أو اسم مورد"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setQ(qInput); }}
          />
        </Field>
        <button className="btn secondary" onClick={() => setQ(qInput)}>بحث</button>
        {visibleRows.length > 0 && <CsvButton filename="purchases.csv" rows={visibleRows.map(toCsvRow)} />}
        <button className="btn secondary" onClick={() => setNonce((n) => n + 1)}>تحديث</button>
      </div>

      <div className="table-scroll">
      <table className="grid dense">
        <thead>
          <tr>
            <th>مرجع</th><th>تاريخ الإضافة</th><th>المورد</th><th>الفرع</th><th>أسطر</th>
            <th>الإجمالي</th><th>المدفوع</th><th>الذمة</th><th>الحالة</th><th>إجراءات</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((p) => {
            const st = STATUS_AR[p.status] ?? { label: p.status, tone: 'warn' as const };
            const paid = p.payments.reduce((s, x) => s + x.amountAgora, 0);
            return (
              <tr key={p.id}>
                <td className="mono" title={p.refNo ?? p.id}><span className="clip">{p.refNo ?? p.id.slice(0, 8)}</span></td>
                <td title={dtShort(p.createdAt)}>{dtDate(p.createdAt)}</td>
                <td title={p.supplier.name}><span className="clip">{p.supplier.name}</span></td>
                <td title={p.branch?.name}><span className="clip">{p.branch?.name ?? '—'}</span></td>
                <td>{p.lines.length}</td>
                <td>{p.totals ? <Money agora={p.totals.grandTotalAgora} /> : '—'}</td>
                <td><Money agora={paid} /></td>
                <td>{p.status === 'received' ? <Money agora={Math.max(0, (p.totals?.grandTotalAgora ?? 0) - paid)} /> : '—'}</td>
                <td><Badge tone={st.tone}>{st.label}</Badge></td>
                <td className="actions">
                  <button className="btn secondary small" onClick={() => navigate(`/purchases/${p.id}`)}>تفاصيل</button>
                  {p.status === 'ordered' && <button className="btn secondary small" onClick={() => act(p.id, 'pending')}>تعليق</button>}
                  {p.status !== 'received' && (
                    <button className="btn small" title="استلام الفاتورة وتسجيل الدفع" onClick={() => setReceiving({ id: p.id, ref: p.refNo ?? p.id.slice(0, 8), amount: 0, code: sources[0]?.code ?? '1000' })}>استلام</button>
                  )}
                </td>
              </tr>
            );
          })}
          {rows && rows.length === 0 && <tr><td colSpan={10}>لا توجد فواتير شراء في النطاق المحدد</td></tr>}
          {!rows && <tr><td colSpan={10}>جارٍ التحميل...</td></tr>}
        </tbody>
      </table>
      </div>
      <p className="muted">{rows ? `${rows.length} فاتورة — مرتبة من الأحدث إلى الأقدم` : ''}</p>

      {receiving && (
        <Modal title={`استلام ${receiving.ref} + دفع`} onClose={() => setReceiving(null)}>
          <Field label="المدفوع الآن (0 = آجل)"><SplitAgora agora={receiving.amount} label="المدفوع الآن" onAgora={(v) => setReceiving({ ...receiving, amount: v })} /></Field>
          <Field label="يُدفع من">
            <select value={receiving.code} onChange={(e) => setReceiving({ ...receiving, code: e.target.value })}>
              {sources.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
          </Field>
          <button className="btn wide" onClick={doReceive}>استلام</button>
        </Modal>
      )}
      {creating && <NewPurchase onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} showToast={showToast} />}
    </div>
  );
}

interface VariantOption {
  variantId: string; label: string; barcode: string | null; sku: string | null;
  imageUrl: string | null; thumbUrl: string | null; costAgora: number | null;
}
interface DraftLine {
  uid: string; variantId: string | null; label: string;
  qty: number; unitCostAgora: number; lineDiscountAgora: number;
}
/** دفعة عند الحفظ والاستلام — من الصندوق أو حساب بنكي (كود GL) */
interface DraftPay { uid: string; code: string; amountAgora: number }

let draftLineSeq = 0;
let draftPaySeq = 0;
const newDraftLine = (): DraftLine => ({ uid: `pl-${++draftLineSeq}`, variantId: null, label: '', qty: 1, unitCostAgora: 0, lineDiscountAgora: 0 });
const newDraftPay = (code: string): DraftPay => ({ uid: `pay-${++draftPaySeq}`, code, amountAgora: 0 });

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

/** نفس ترتيب الحساب الملزم في الخادم: خصم السطر ← توزيع خصم الفاتورة بالتناسب ← الضريبة بعد الخصومات */
function computeDraftTotals(lines: DraftLine[], discountAgora: number, taxBps: number) {
  const gross = lines.map((l) => l.qty * l.unitCostAgora);
  const afterLine = lines.map((l, i) => Math.max(0, gross[i] - l.lineDiscountAgora));
  const subtotal = afterLine.reduce((s, x) => s + x, 0);
  const shares = allocateProRata(Math.min(discountAgora, subtotal), afterLine);
  const rows = lines.map((l, i) => {
    const taxable = afterLine[i] - shares[i];
    return { taxable, tax: Math.round((taxable * taxBps) / 10000) };
  });
  const inventoryTotalAgora = rows.reduce((s, r) => s + r.taxable, 0);
  const taxTotalAgora = rows.reduce((s, r) => s + r.tax, 0);
  return { inventoryTotalAgora, taxTotalAgora, grandTotalAgora: inventoryTotalAgora + taxTotalAgora };
}

function NewPurchase({ onClose, onDone, showToast }: { onClose: () => void; onDone: () => void; showToast: (m: string, t?: 'ok' | 'bad') => void }) {
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [refNo, setRefNo] = useState('');
  const [notes, setNotes] = useState('');
  const [discountAgora, setDiscount] = useState(0);
  const [taxBps, setTaxBps] = useState(0);
  const [lines, setLines] = useState<DraftLine[]>([newDraftLine()]);
  const [pays, setPays] = useState<DraftPay[]>([]);
  const [saving, setSaving] = useState(false);
  const { sources } = usePaySources(true);

  useEffect(() => {
    api<any[]>('/parties/suppliers').then((s) => {
      setSuppliers(s);
      if (s[0]) setSupplierId(s[0].id);
    });
    api<any[]>('/org/branches').then((bs) => {
      setBranches(bs);
      if (bs[0]) setBranchId(bs[0].id);
    }).catch(() => undefined);
  }, []);

  const totals = useMemo(() => computeDraftTotals(lines, discountAgora, taxBps), [lines, discountAgora, taxBps]);
  const paidTotal = pays.reduce((s, p) => s + p.amountAgora, 0);
  const remainder = Math.max(0, totals.grandTotalAgora - paidTotal);
  const overpay = paidTotal > totals.grandTotalAgora;
  const firstCode = sources[0]?.code ?? '1000';

  const patchLine = (uid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));
  const patchPay = (uid: string, patch: Partial<DraftPay>) =>
    setPays((prev) => prev.map((p) => (p.uid === uid ? { ...p, ...patch } : p)));

  const pickVariant = (uid: string) => (o: VariantOption | null) =>
    setLines((prev) => prev.map((l) => {
      if (l.uid !== uid) return l;
      if (!o) return { ...l, variantId: null, label: '' };
      // تعبئة التكلفة تلقائياً من تكلفة الفرع إذا كانت فارغة
      const cost = l.unitCostAgora > 0 || o.costAgora === null ? l.unitCostAgora : o.costAgora;
      return { ...l, variantId: o.variantId, label: o.label, unitCostAgora: cost };
    }));

  const addRemainderPay = () => {
    if (remainder <= 0) return;
    setPays((prev) => [...prev, { ...newDraftPay(firstCode), amountAgora: remainder }]);
  };

  const validate = (receiveNow: boolean): string | null => {
    if (!supplierId) return 'اختر المورد';
    if (!lines.length || lines.some((l) => !l.variantId)) return 'اختر الصنف في كل سطر (بحث بالاسم أو SKU أو الباركود)';
    if (receiveNow) {
      if (pays.some((p) => p.amountAgora < 0)) return 'مبلغ الدفعة غير صالح';
      if (overpay) return 'إجمالي الدفعات أكبر من إجمالي الفاتورة';
    }
    return null;
  };

  const submit = async (receiveNow: boolean) => {
    const err = validate(receiveNow);
    if (err) { showToast(err, 'bad'); return; }
    setSaving(true);
    try {
      const created = await api<{ id: string }>('/purchases', {
        method: 'POST',
        body: {
          branchId: branchId || undefined, supplierId, refNo: refNo || undefined, notes: notes || undefined,
          discountAgora, taxRateBps: taxBps,
          lines: lines.map((l) => ({ variantId: l.variantId!, qty: l.qty, unitCostAgora: l.unitCostAgora, lineDiscountAgora: l.lineDiscountAgora })),
        },
      });
      if (!receiveNow) {
        showToast('أُنشئت فاتورة الشراء (طلبية) — الأثر المخزني والمحاسبي عند الاستلام');
        onDone();
        return;
      }
      const payments = pays.filter((p) => p.amountAgora > 0).map((p) => ({ accountCode: p.code, amountAgora: p.amountAgora }));
      try {
        const res = await api<any>(`/purchases/${created.id}/status`, { method: 'POST', body: { status: 'received', payments } });
        showToast(`استُلمت — الإجمالي ${money(res.totals.grandTotalAgora)}، ذمة: ${money(res.remainderAgora)}`);
      } catch (e) {
        // الفاتورة أُنشئت فعلاً — لا نكرر الإنشاء؛ يُمكن الاستلام لاحقاً من القائمة
        showToast(`أُنشئت الفاتورة (طلبية) لكن تعذّر الاستلام: ${(e as Error).message}`, 'bad');
      }
      onDone();
    } catch (e) { showToast((e as Error).message, 'bad'); } finally { setSaving(false); }
  };

  return (
    <div>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head"><h3>فاتورة شراء جديدة</h3><button className="btn secondary" onClick={onClose}>✕</button></div>
          <div className="modal-body">
            <div className="row2">
              <Field label="المورد *">
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label="الفرع">
                <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <Field label="رقم مرجعي"><input value={refNo} onChange={(e) => setRefNo(e.target.value)} /></Field>
              <Field label="ملاحظات"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            </div>
            <div className="row2">
              <Field label="خصم فاتورة"><SplitAgora agora={discountAgora} onAgora={setDiscount} label="خصم فاتورة" /></Field>
              <Field label="ضريبة (نقطة أساس)" hint="1600 = 16٪ — تُحسب بعد الخصومات"><input type="number" value={taxBps} onChange={(e) => setTaxBps(Number(e.target.value) || 0)} /></Field>
            </div>

            <h4>الأسطر</h4>
            {lines.map((l) => (
              <div className="row2 purchase-line" key={l.uid}>
                <VariantPicker
                  branchId={branchId}
                  picked={l.variantId ? { variantId: l.variantId, label: l.label } : null}
                  onPick={pickVariant(l.uid)}
                />
                <input type="number" placeholder="كمية" min={1} value={l.qty} style={{ width: 80 }} onChange={(e) => patchLine(l.uid, { qty: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
                <SplitAgora agora={l.unitCostAgora} label="تكلفة الوحدة" onAgora={(v) => patchLine(l.uid, { unitCostAgora: v })} />
                <SplitAgora agora={l.lineDiscountAgora} label="خصم المنتج" onAgora={(v) => patchLine(l.uid, { lineDiscountAgora: v })} />
                <button className="btn secondary small" onClick={() => setLines((prev) => prev.filter((x) => x.uid !== l.uid))}>✕</button>
              </div>
            ))}
            <button className="btn secondary" onClick={() => setLines((prev) => [...prev, newDraftLine()])}>+ سطر</button>

            <div className="purchase-totals">
              <div><span>إجمالي المخزون (قبل الضريبة)</span><Money agora={totals.inventoryTotalAgora} /></div>
              <div><span>الضريبة ({taxBps / 100}%)</span><Money agora={totals.taxTotalAgora} /></div>
              <div className="grand"><span>الإجمالي</span><Money agora={totals.grandTotalAgora} className="grand" /></div>
              <div><span>إجمالي الدفعات</span><Money agora={paidTotal} /></div>
              <div><span>{remainder > 0 ? 'الذمة المتبقية (آجل)' : 'مسددة بالكامل'}</span><Money agora={remainder} /></div>
            </div>
            {overpay && <p className="alert bad">إجمالي الدفعات أكبر من إجمالي الفاتورة — صحّح المبالغ قبل الحفظ</p>}

            <h4>الدفعات — نقد / بنك / حسابات</h4>
            <p className="muted">تُسجَّل الدفعات وتُرحَّل محاسبياً مع الاستلام الفوري. دون دفعات تُحفظ الفاتورة آجلة بالكامل (ذمة على المورد).</p>
            {pays.map((p) => (
              <div className="pay-row" key={p.uid}>
                <select value={p.code} onChange={(e) => patchPay(p.uid, { code: e.target.value })} aria-label="حساب الدفع">
                  {sources.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
                </select>
                <SplitAgora agora={p.amountAgora} label="مبلغ الدفعة" onAgora={(v) => patchPay(p.uid, { amountAgora: v })} />
                <button className="btn secondary small" onClick={() => setPays((prev) => prev.filter((x) => x.uid !== p.uid))}>✕</button>
              </div>
            ))}
            <div className="row2">
              <button className="btn secondary" onClick={() => setPays((prev) => [...prev, newDraftPay(firstCode)])}>+ إضافة دفعة</button>
              <button className="btn secondary" disabled={remainder <= 0} onClick={addRemainderPay}>دفع المتبقي كاملاً</button>
            </div>

            <p className="muted">ابحث عن الصنف بالاسم أو SKU أو امسح الباركود — يُضاف فوراً عند تطابق الباركود. دفع جزئي والباقي ذمة تلقائياً.</p>
          </div>
          <div className="modal-foot">
            <button className="btn secondary" disabled={saving} onClick={() => void submit(false)}>{saving ? 'جارٍ الحفظ...' : 'حفظ كطلبية'}</button>
            <button className="btn" disabled={saving || overpay} onClick={() => void submit(true)}>{saving ? 'جارٍ الحفظ...' : 'حفظ واستلام + دفع'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SearchRes {
  products: {
    id: string; name: string; sku: string | null; imageUrl: string | null; thumbUrl: string | null;
    variants: { id: string; name: string; barcode: string }[];
    branchData: { cost: string }[];
  }[];
}

/** خانة اختيار الصنف: بحث اسم / SKU / باركود مع قائمة نتائج — الباركود المطابق يُضاف فوراً (قارئ الباركود) */
function VariantPicker({ branchId, picked, onPick }: {
  branchId: string;
  picked: { variantId: string; label: string } | null;
  onPick: (o: VariantOption | null) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<VariantOption[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  const choose = (o: VariantOption | null) => {
    pickRef.current(o);
    setQ('');
    setOpen(false);
    setResults([]);
  };

  useEffect(() => {
    const term = q.trim();
    if (!term) { setResults([]); setOpen(false); return; }
    let alive = true;
    setBusy(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await api<SearchRes>(`/catalog/search?branchId=${branchId}&q=${encodeURIComponent(term)}`);
        if (!alive) return;
        const opts: VariantOption[] = r.products.flatMap((p) => p.variants.map((v) => ({
          variantId: v.id,
          label: p.variants.length > 1 ? `${p.name} — ${v.name}` : p.name,
          barcode: v.barcode,
          sku: p.sku,
          imageUrl: p.imageUrl,
          thumbUrl: p.thumbUrl,
          costAgora: p.branchData[0] ? toAgora(p.branchData[0].cost) : null,
        })));
        setResults(opts);
        setOpen(true);
        // باركود مطابق تماماً → اختيار فوري بدون ضغط (مسح بالقارئ)
        const exact = opts.find((o) => o.barcode && o.barcode === term);
        if (exact) choose(exact);
      } catch { if (alive) { setResults([]); setOpen(false); } } finally { if (alive) setBusy(false); }
    }, 250);
    return () => { alive = false; window.clearTimeout(t); };
  }, [q, branchId]);

  // إغلاق القائمة عند النقر خارجها
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="item-search" ref={wrapRef}>
      <input
        placeholder={picked ? picked.label : 'اسم الصنف / SKU / باركود'}
        value={picked ? picked.label : q}
        title={picked ? picked.label : 'ابحث بالاسم أو SKU أو الباركود'}
        onChange={(e) => { if (picked) onPick(null); setQ(e.target.value); }}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && open && results[0]) { e.preventDefault(); choose(results[0]); }
          if (e.key === 'Escape') setOpen(false);
        }}
        aria-label="البحث عن صنف"
      />
      {busy && <span className="item-search-busy">⏳</span>}
      {open && (
        <div className="search-results">
          {results.map((o) => (
            <button key={o.variantId} className="result-row" type="button" onClick={() => choose(o)}>
              <span className="result-main">
                {o.label}
                <small className="mono">{o.barcode ?? ''}{o.sku ? ` · ${o.sku}` : ''}</small>
              </span>
              {o.costAgora !== null && <strong>{money(o.costAgora)}</strong>}
            </button>
          ))}
          {results.length === 0 && <span className="result-row muted">لا نتائج مطابقة</span>}
        </div>
      )}
    </div>
  );
}
