import { useEffect, useState } from 'react';
import { api, money } from '../api.js';
import { Badge, Field, Modal, Money, useToast } from '../ui.js';
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
    <div className="card">
      {toast}
      <div className="row-between">
        <h2>المشتريات — الأثر المخزني والمحاسبي عند الاستلام فقط</h2>
        <button className="btn" onClick={() => setCreating(true)}>+ فاتورة شراء</button>
      </div>
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
                {p.status === 'ordered' && <button className="btn secondary small" onClick={() => act(p.id, 'pending')}>تعليق</button>}
                {p.status !== 'received' && (
                  <button className="btn small" onClick={() => setReceiving({ id: p.id, ref: p.refNo ?? p.id.slice(0, 8), amount: 0, code: sources[0]?.code ?? '1000' })}>استلام + دفع</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {receiving && (
        <Modal title={`استلام ${receiving.ref} + دفع`} onClose={() => setReceiving(null)}>
          <Field label="المدفوع الآن (أغورات، 0 = آجل)"><input type="number" min={0} value={receiving.amount} onChange={(e) => setReceiving({ ...receiving, amount: Number(e.target.value) })} /></Field>
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

function NewPurchase({ onClose, onDone, showToast }: { onClose: () => void; onDone: () => void; showToast: (m: string, t?: 'ok' | 'bad') => void }) {
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [refNo, setRefNo] = useState('');
  const [discountAgora, setDiscount] = useState(0);
  const [taxBps, setTaxBps] = useState(0);
  const [lines, setLines] = useState<{ variantName: string; qty: number; unitCostAgora: number; lineDiscountAgora: number }[]>([]);
  const [payAgora, setPay] = useState(0);
  const [variants, setVariants] = useState<{ id: string; label: string }[]>([]);

  useEffect(() => {
    api<any[]>('/parties/suppliers').then((s) => {
      setSuppliers(s);
      if (s[0]) setSupplierId(s[0].id);
    });
    api<any[]>('/inventory/stock').then((rows) =>
      setVariants(rows.flatMap((p) => p.variants.map((v: any) => ({ id: v.id, label: `${p.name} — ${v.name}` })))),
    );
  }, []);

  const submit = async () => {
    try {
      const variantIds = await Promise.all(lines.map(async (l) => {
        const s = await api<SearchLike>(`/catalog/search?branchId=${(await api<any[]>('/org/branches'))[0].id}&q=${encodeURIComponent(l.variantName)}`);
        const v = s.products[0]?.variants[0];
        if (!v) throw new Error(`لا متغير: ${l.variantName}`);
        return { variantId: v.id, qty: l.qty, unitCostAgora: l.unitCostAgora, lineDiscountAgora: l.lineDiscountAgora };
      }));
      await api('/purchases', {
        method: 'POST',
        body: { supplierId, refNo: refNo || undefined, discountAgora, taxRateBps: taxBps, lines: variantIds },
      });
      showToast('أُنشئت فاتورة الشراء (طلبية)');
      onDone();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div>
      {lines.length > 0 && <button className="btn" style={{ position: 'fixed', top: 80, insetInlineEnd: 30, zIndex: 60 }} onClick={submit}>حفظ فاتورة الشراء ({lines.length})</button>}
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
              <Field label="خصم فاتورة (أغورات)"><input type="number" value={discountAgora} onChange={(e) => setDiscount(Number(e.target.value))} /></Field>
              <Field label="ضريبة (نقطة أساس)"><input type="number" value={taxBps} onChange={(e) => setTaxBps(Number(e.target.value))} /></Field>
            </div>
            {lines.map((l, i) => (
              <div className="row2" key={i}>
                <input placeholder="اسم الصنف" value={l.variantName} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, variantName: e.target.value } : x))} />
                <input type="number" placeholder="كمية" value={l.qty} style={{ width: 80 }} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: Number(e.target.value) } : x))} />
                <input type="number" placeholder="تكلفة الوحدة" value={l.unitCostAgora} style={{ width: 110 }} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, unitCostAgora: Number(e.target.value) } : x))} />
                <input type="number" placeholder="خصم المنتج" value={l.lineDiscountAgora} style={{ width: 100 }} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, lineDiscountAgora: Number(e.target.value) } : x))} />
                <button className="btn secondary small" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <button className="btn secondary" onClick={() => setLines([...lines, { variantName: '', qty: 1, unitCostAgora: 0, lineDiscountAgora: 0 }])}>+ سطر</button>
            <Field label="المدفوع عند الاستلام (أغورات)"><input type="number" value={payAgora} onChange={(e) => setPay(Number(e.target.value))} /></Field>
            <p className="muted">الأسطر تُحل إلى متغيرات بالباركود عند الحفظ — دفع جزئي والباقي ذمة تلقائياً.</p>
            <div className="muted">{variants.length} متغير متاح</div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SearchLike { products: { variants: { id: string }[] }[] }
