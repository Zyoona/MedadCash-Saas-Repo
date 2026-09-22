import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toAgora } from '@medad/shared-types';
import { api, money } from '../api.js';
import { Badge, Field, Modal, Money, SplitAgora, useToast } from '../ui.js';
import { usePaySources } from '../banks.js';

interface PurchaseRow {
  id: string; status: string; refNo: string | null; discountAgora: number; taxRateBps: number; taxAgora: number;
  supplier: { name: string };
  lines: { id: string; variantId: string; qty: number; unitCostAgora: number; lineDiscountAgora: number }[];
  payments: { amountAgora: number }[];
}

export function Purchases() {
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<{ id: string; ref: string; amount: number; code: string } | null>(null);
  const { sources } = usePaySources(true);
  const [toast, showToast] = useToast();
  const navigate = useNavigate();

  const load = () => api<PurchaseRow[]>('/purchases').then(setRows).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  const act = async (id: string, status: 'pending' | 'received', payments: { accountCode: string; amountAgora: number }[] = []) => {
    try {
      const res = await api<any>(`/purchases/${id}/status`, { method: 'POST', body: { status, payments } });
      showToast(status === 'received' ? `استُلمت — الإجمالي ${money(res.totals.grandTotalAgora)}، ذمة: ${money(res.remainderAgora)}` : 'أُعيدت إلى قيد الانتظار (لم تُستلم بعد)');
      load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const doReceive = async () => {
    if (!receiving) return;
    act(receiving.id, 'received', receiving.amount > 0 ? [{ accountCode: receiving.code, amountAgora: receiving.amount }] : []);
    setReceiving(null);
  };

  return (
    <div className="card full">
      {toast}
      <div className="row-between">
        <h2>المشتريات — الأثر المخزني والمحاسبي عند الاستلام فقط</h2>
        <button className="btn" onClick={() => setCreating(true)}>+ فاتورة شراء</button>
      </div>
      <div className="table-scroll">
      <table className="grid">
        <thead><tr><th>مرجع</th><th>المورد</th><th>أسطر</th><th>ضريبة</th><th>الحالة</th><th>إجراءات</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="mono">{p.refNo ?? p.id.slice(0, 8)}</td>
              <td>{p.supplier.name}</td>
              <td>{p.lines.length}</td>
              <td><Money agora={p.taxAgora} /></td>
              <td><Badge tone={p.status === 'received' ? 'ok' : 'warn'}>{p.status === 'received' ? 'مستلمة' : p.status === 'pending' ? 'معلقة' : 'طلبية'}</Badge></td>
              <td className="actions">
                <button className="btn secondary small" onClick={() => navigate(`/purchases/${p.id}`)}>تفاصيل</button>
                {p.status === 'ordered' && <button className="btn secondary small" onClick={() => act(p.id, 'pending')}>تعليق</button>}
                {p.status !== 'received' && (
                  <button className="btn small" onClick={() => setReceiving({ id: p.id, ref: p.refNo ?? p.id.slice(0, 8), amount: 0, code: sources[0]?.code ?? '1000' })}>استلام + دفع</button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6}>لا توجد فواتير شراء</td></tr>}
        </tbody>
      </table>
      </div>
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

let draftLineSeq = 0;
const newDraftLine = (): DraftLine => ({ uid: `pl-${++draftLineSeq}`, variantId: null, label: '', qty: 1, unitCostAgora: 0, lineDiscountAgora: 0 });

function NewPurchase({ onClose, onDone, showToast }: { onClose: () => void; onDone: () => void; showToast: (m: string, t?: 'ok' | 'bad') => void }) {
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [refNo, setRefNo] = useState('');
  const [discountAgora, setDiscount] = useState(0);
  const [taxBps, setTaxBps] = useState(0);
  const [lines, setLines] = useState<DraftLine[]>([newDraftLine()]);
  const [payAgora, setPay] = useState(0);
  const [branchId, setBranchId] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<any[]>('/parties/suppliers').then((s) => {
      setSuppliers(s);
      if (s[0]) setSupplierId(s[0].id);
    });
    api<any[]>('/org/branches').then((bs) => { if (bs[0]) setBranchId(bs[0].id); }).catch(() => undefined);
  }, []);

  const patchLine = (uid: string, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));

  const pickVariant = (uid: string) => (o: VariantOption | null) =>
    setLines((prev) => prev.map((l) => {
      if (l.uid !== uid) return l;
      if (!o) return { ...l, variantId: null, label: '' };
      // تعبئة التكلفة تلقائياً من تكلفة الفرع إذا كانت فارغة
      const cost = l.unitCostAgora > 0 || o.costAgora === null ? l.unitCostAgora : o.costAgora;
      return { ...l, variantId: o.variantId, label: o.label, unitCostAgora: cost };
    }));

  const submit = async () => {
    if (lines.some((l) => !l.variantId)) { showToast('اختر الصنف في كل سطر (بحث بالاسم أو SKU أو الباركود)', 'bad'); return; }
    if (!lines.length) { showToast('أضف سطراً واحداً على الأقل', 'bad'); return; }
    setSaving(true);
    try {
      await api('/purchases', {
        method: 'POST',
        body: {
          supplierId, refNo: refNo || undefined, discountAgora, taxRateBps: taxBps,
          lines: lines.map((l) => ({ variantId: l.variantId!, qty: l.qty, unitCostAgora: l.unitCostAgora, lineDiscountAgora: l.lineDiscountAgora })),
        },
      });
      showToast('أُنشئت فاتورة الشراء (طلبية)');
      onDone();
    } catch (e) { showToast((e as Error).message, 'bad'); } finally { setSaving(false); }
  };

  return (
    <div>
      {lines.length > 0 && <button className="btn" style={{ position: 'fixed', top: 80, insetInlineEnd: 30, zIndex: 60 }} disabled={saving} onClick={submit}>{saving ? 'جارٍ الحفظ...' : `حفظ فاتورة الشراء (${lines.length})`}</button>}
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head"><h3>فاتورة شراء جديدة</h3><button className="btn secondary" onClick={onClose}>✕</button></div>
          <div className="modal-body">
            <Field label="المورد *">
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <div className="row2">
              <Field label="رقم مرجعي"><input value={refNo} onChange={(e) => setRefNo(e.target.value)} /></Field>
              <Field label="خصم فاتورة"><SplitAgora agora={discountAgora} onAgora={setDiscount} label="خصم فاتورة" /></Field>
              <Field label="ضريبة (نقطة أساس)"><input type="number" value={taxBps} onChange={(e) => setTaxBps(Number(e.target.value))} /></Field>
            </div>
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
            <Field label="المدفوع عند الاستلام"><SplitAgora agora={payAgora} onAgora={setPay} label="المدفوع عند الاستلام" /></Field>
            <p className="muted">ابحث عن الصنف بالاسم أو SKU أو امسح الباركود — يُضاف فوراً عند تطابق الباركود. دفع جزئي والباقي ذمة تلقائياً.</p>
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
