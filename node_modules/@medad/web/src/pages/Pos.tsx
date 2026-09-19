import { useEffect, useMemo, useState } from 'react';
import { api, auditEvent, money } from '../api.js';
import { computeInvoice } from '@medad/shared-types';
import { Badge, Field, Money, Tabs, useToast } from '../ui.js';
import { useAuth } from '../auth.js';
import { bankLabel, useBanks, usePaySources } from '../banks.js';

// POS (§Phase4): بحث اسم/SKU/باركود + خصم سطر وفاتورة + ضريبة أخيراً + دفع متعدد
// + إرجاع الباقي بطريقة مختلفة (سالب) + مرتجعات + عروض أسعار — بنفس ترتيب الحساب الملزم.

const METHODS = [
  { method: 'cash', accountCode: '1000', label: 'نقد' },
  { method: 'bank', accountCode: '1100', label: 'بنك' },
  { method: 'check', accountCode: '1200', label: 'شيك' },
];

interface SearchRes {
  products: { id: string; name: string; sku: string | null; variants: { id: string; name: string; barcode: string }[]; branchData: { price: string }[] }[];
  unitMatch: { id: string; barcode: string | null; product: { id: string; name: string; branchData: { price: string }[] } }[];
}
interface CartLine { productId: string; variantId: string | null; name: string; qty: number; priceAgora: number; lineDiscountAgora: number }
interface Customer { id: string; name: string; isCashDefault: boolean }
interface Shift { id: string; openedAt: string }

export function Pos() {
  const { user } = useAuth();
  const [tab, setTab] = useState('sell');
  const [toast, showToast] = useToast();
  const [branchId, setBranchId] = useState('');
  const [shift, setShift] = useState<Shift | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchRes | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [invoiceDiscount, setInvoiceDiscount] = useState(0);
  const [discountPct, setDiscountPct] = useState(0);
  const [taxBps, setTaxBps] = useState(0);
  const [payments, setPayments] = useState<{ method: string; accountCode: string; amountAgora: number }[]>([]);
  const { banks } = useBanks(true);
  const defaultBankCode = banks[0]?.glAccountCode ?? '1100';

  useEffect(() => {
    api<any>('/org/branches').then((bs) => {
      const b = bs[0];
      if (b) setBranchId(b.id);
    });
    api<Customer[]>('/parties/customers').then((cs) => {
      setCustomers(cs);
      const cash = cs.find((c) => c.isCashDefault);
      if (cash) setCustomerId(cash.id);
    });
    api<Record<string, unknown>>('/settings').then((s) => {
      const rate = (s as { tax_rate?: { rateBps?: number } }).tax_rate;
      setTaxBps(rate?.rateBps ?? 0);
    });
  }, []);

  useEffect(() => {
    if (!branchId) return;
    api<Shift | null>('/sales/shifts/current').then(setShift).catch(() => setShift(null));
  }, [branchId]);

  const search = async (term: string) => {
    setQ(term);
    if (term.trim().length < 1) { setResults(null); return; }
    const r = await api<SearchRes>(`/catalog/search?branchId=${branchId}&q=${encodeURIComponent(term)}`);
    setResults(r);
    auditEvent('search', 'catalog');
    // باركود مباشر → أضف للسلة فوراً
    const exact = r.products.find((p) => p.variants.some((v) => v.barcode === term.trim()));
    if (exact) {
      addToCart(exact.id, exact.variants[0].id, exact.name, Math.round(Number(exact.branchData[0]?.price ?? 0) * 100));
      setResults(null);
      setQ('');
    }
  };

  const addToCart = (productId: string, variantId: string | null, name: string, priceAgora: number) => {
    setCart((c) => {
      const existing = c.find((l) => l.productId === productId && l.variantId === variantId && l.priceAgora === priceAgora);
      if (existing) return c.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l));
      return [...c, { productId, variantId, name, qty: 1, priceAgora, lineDiscountAgora: 0 }];
    });
  };

  const totals = useMemo(() => {
    const disc = discountPct > 0 ? Math.round((cart.reduce((s, l) => s + (l.qty * l.priceAgora - l.lineDiscountAgora), 0) * discountPct) / 100) : invoiceDiscount;
    return computeInvoice(
      cart.map((l) => ({ qty: l.qty, unitPriceAgora: l.priceAgora, lineDiscountAgora: l.lineDiscountAgora, taxRateBps: taxBps })),
      disc,
    );
  }, [cart, invoiceDiscount, discountPct, taxBps]);

  const paidNet = payments.reduce((s, p) => s + p.amountAgora, 0);
  const remainder = totals.grandTotalAgora - paidNet;

  const checkout = async () => {
    try {
      const res = await api<{ invoiceId: string; warnings: string[] }>('/sales/invoices', {
        method: 'POST',
        body: { branchId, customerId: customerId || null, shiftId: shift?.id ?? null, invoiceDiscountAgora: totals.invoiceDiscountAgora, lines: cart, payments },
      });
      showToast(`تمت الفاتورة: ${res.invoiceId.slice(0, 8)}${res.warnings.length ? ' — ' + res.warnings.join('، ') : ''}`, res.warnings.length ? 'bad' : 'ok');
      setCart([]); setPayments([]); setInvoiceDiscount(0); setDiscountPct(0);
    } catch (e) {
      showToast((e as Error).message, 'bad');
    }
  };

  // ─── الورديات ───
  const openShift = async (openingAgora: number) => {
    try {
      const s = await api<Shift>('/sales/shifts/open', { method: 'POST', body: { openingAmountAgora: openingAgora } });
      setShift(s);
      showToast('تم افتتاح الوردية');
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };
  const closeShift = async (actualAgora: number) => {
    if (!shift) return;
    try {
      const rep = await api<any>(`/sales/shifts/${shift.id}/close`, { method: 'POST', body: { closingActualAgora: actualAgora } });
      showToast(`أُقفلت الوردية — متوقع ${money(rep.expectedAgora)} / فعلي ${money(actualAgora)}`);
      setShift(null);
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div className="pos-page">
      {toast}
      <div className="pos-toolbar">
        <Tabs active={tab} onChange={setTab} tabs={[{ id: 'sell', label: 'بيع' }, { id: 'return', label: 'مرتجع' }, { id: 'quotes', label: 'عروض الأسعار' }]} />
        <ShiftBanner shift={shift} onOpen={openShift} onClose={closeShift} />
      </div>
      {tab === 'sell' && (
        <div className="pos-grid">
          <div className="card pos-catalog">
            <div className="pos-catalog-head">
              <h3>الأصناف</h3>
              <div className="pos-search">
                <input placeholder="بحث اسم / SKU / باركود..." value={q} onChange={(e) => void search(e.target.value)} />
                {results && (
                  <div className="search-results">
                    {results.products.map((p) => {
                      const price = Math.round(Number(p.branchData[0]?.price ?? 0) * 100);
                      return p.variants.length > 0 ? p.variants.map((v) => (
                        <button key={v.id} className="result-row" onClick={() => { addToCart(p.id, v.id, `${p.name} (${v.name})`, price); setResults(null); setQ(''); }}>
                          {p.name} — {v.name} <small>{v.barcode}</small> <strong>{money(price)}</strong>
                        </button>
                      )) : (
                        <button key={p.id} className="result-row" disabled={p.branchData.length === 0} onClick={() => { addToCart(p.id, null, p.name, price); setResults(null); setQ(''); }}>
                          {p.name} <strong>{money(price)}</strong>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <div className="pos-scroll">
              <table className="grid">
                <thead><tr><th>الصنف</th><th>كمية</th><th>سعر</th><th>خصم سطر</th><th>إجمالي</th><th></th></tr></thead>
                <tbody>
                  {cart.map((l, i) => (
                    <tr key={i}>
                      <td>{l.name}</td>
                      <td><input type="number" min={1} value={l.qty} onChange={(e) => setCart(cart.map((x, j) => j === i ? { ...x, qty: Number(e.target.value) } : x))} style={{ width: 64 }} /></td>
                      <td><input type="number" min={0} value={l.priceAgora} onChange={(e) => setCart(cart.map((x, j) => j === i ? { ...x, priceAgora: Number(e.target.value) } : x))} style={{ width: 84 }} /></td>
                      <td><input type="number" min={0} value={l.lineDiscountAgora} onChange={(e) => setCart(cart.map((x, j) => j === i ? { ...x, lineDiscountAgora: Number(e.target.value) } : x))} style={{ width: 84 }} /></td>
                      <td>{money(l.qty * l.priceAgora - l.lineDiscountAgora)}</td>
                      <td><button className="btn secondary small" onClick={() => setCart(cart.filter((_, j) => j !== i))}>✕</button></td>
                    </tr>
                  ))}
                  {cart.length === 0 && <tr><td colSpan={6}>السلة فارغة — ابحث وأضف الأصناف</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card pos-pay">
            <div className="pos-pay-head">
              <h3>الدفع</h3>
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="الزبون">
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isCashDefault ? ' (نقدي)' : ''}</option>)}
              </select>
            </div>
            <div className="row2 pos-discounts">
              <Field label="خصم فاتورة (أغورات)"><input type="number" min={0} value={discountPct > 0 ? 0 : invoiceDiscount} onChange={(e) => setInvoiceDiscount(Number(e.target.value))} disabled={discountPct > 0} /></Field>
              <Field label="خصم %"><input type="number" min={0} max={100} value={discountPct} onChange={(e) => setDiscountPct(Number(e.target.value))} /></Field>
            </div>
            <div className="totals">
              <div><span>بعد الخصومات</span><Money agora={totals.taxableTotalAgora} /></div>
              <div><span>الضريبة ({taxBps / 100}%)</span><Money agora={totals.taxTotalAgora} /></div>
              <div className="grand"><span>الإجمالي</span><Money agora={totals.grandTotalAgora} /></div>
              <div><span>المدفوع</span><Money agora={paidNet} /></div>
              <div><span>{remainder > 0 ? 'آجل (ذمة)' : 'الباقي'}</span><Money agora={Math.abs(remainder)} /></div>
            </div>
            <div className="pos-pays">
              {payments.map((p, i) => (
                <div className="pay-row" key={i}>
                  <select value={p.method} onChange={(e) => {
                    const m = METHODS.find((m) => m.method === e.target.value)!;
                    const code = m.method === 'bank' ? defaultBankCode : m.accountCode;
                    setPayments(payments.map((x, j) => j === i ? { ...x, method: m.method, accountCode: code } : x));
                  }}>
                    {METHODS.map((m) => <option key={m.method} value={m.method}>{m.label}</option>)}
                  </select>
                  {p.method === 'bank' && (
                    <select value={p.accountCode} onChange={(e) => setPayments(payments.map((x, j) => j === i ? { ...x, accountCode: e.target.value } : x))} aria-label="الحساب البنكي">
                      {banks.map((b) => <option key={b.glAccountCode} value={b.glAccountCode}>{bankLabel(b)}</option>)}
                    </select>
                  )}
                  <input type="number" value={p.amountAgora} onChange={(e) => setPayments(payments.map((x, j) => j === i ? { ...x, amountAgora: Number(e.target.value) } : x))} />
                  <button className="btn secondary small" onClick={() => setPayments(payments.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
            </div>
            <div className="row2 pos-pay-actions">
              <button className="btn secondary" onClick={() => setPayments([...payments, { method: 'cash', accountCode: '1000', amountAgora: remainder > 0 ? remainder : 0 }])}>+ دفعة</button>
              <button className="btn secondary" onClick={() => setPayments([...payments, { method: 'bank', accountCode: defaultBankCode, amountAgora: 0 }])}>+ إرجاع باقي</button>
            </div>
            <button className="btn wide" disabled={cart.length === 0 || remainder < 0} onClick={checkout}>إتمام البيع</button>
          </div>
        </div>
      )}
      {tab === 'return' && <div className="pos-alt"><ReturnTab onToast={showToast} /></div>}
      {tab === 'quotes' && <div className="pos-alt"><QuotesTab onToast={showToast} canConvert={!!user?.perms.includes('quotations.manage') || !!user?.perms.includes('*')} /></div>}
    </div>
  );
}

function ShiftBanner({ shift, onOpen, onClose }: { shift: Shift | null; onOpen: (n: number) => void; onClose: (n: number) => void }) {
  const [opening, setOpening] = useState(0);
  const [actual, setActual] = useState(0);
  if (shift) {
    return (
      <div className="shift-banner open">
        <span className="shift-status">وردية مفتوحة · {new Date(shift.openedAt).toLocaleTimeString('ar')}</span>
        <input type="number" placeholder="الفعلي (أغورات)" value={actual} onChange={(e) => setActual(Number(e.target.value))} />
        <button className="btn small" onClick={() => onClose(actual)}>إقفال</button>
      </div>
    );
  }
  return (
    <div className="shift-banner">
      <span className="shift-status">لا وردية مفتوحة</span>
      <input type="number" placeholder="افتتاح (أغورات)" value={opening} onChange={(e) => setOpening(Number(e.target.value))} />
      <button className="btn small" onClick={() => onOpen(opening)}>افتتاح</button>
    </div>
  );
}

function ReturnTab({ onToast }: { onToast: (m: string, t?: 'ok' | 'bad') => void }) {
  const [ref, setRef] = useState('');
  const [invoice, setInvoice] = useState<any>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [fee, setFee] = useState(0);
  const [method, setMethod] = useState('cash');
  const { banks, sources } = usePaySources(true);
  const [refundCode, setRefundCode] = useState('1000');

  const load = async () => {
    try {
      const list = await api<any>(`/sales/invoices?refNo=${encodeURIComponent(ref)}`);
      const inv = list.rows?.[0];
      if (!inv) { onToast('لم تُوجد فاتورة بهذا المرجع', 'bad'); return; }
      const full = await api<any>(`/sales/invoices/${inv.id}`);
      setInvoice(full);
    } catch (e) { onToast((e as Error).message, 'bad'); }
  };

  const submit = async () => {
    try {
      const lines = Object.entries(qty).filter(([, n]) => n > 0).map(([variantId, n]) => ({ variantId, qty: n }));
      const res = await api<{ refundGrossAgora: number }>('/sales/returns', {
        method: 'POST',
        body: {
          sourceInvoiceId: invoice.id, lines,
          restockingFeeAgora: fee,
          refundMethod: method,
          refundAccountCode: method === 'credit' ? '1300' : method === 'bank' ? refundCode : '1000',
        },
      });
      onToast(`تم المرتجع — الرد: ${money(res.refundGrossAgora)}`);
      setInvoice(null); setQty({}); setFee(0);
    } catch (e) { onToast((e as Error).message, 'bad'); }
  };

  return (
    <div className="card">
      <h3>مرتجع بيع — بحث برقم/مرجع الفاتورة</h3>
      <div className="row2">
        <input placeholder="رقم الفاتورة أو المرجع" value={ref} onChange={(e) => setRef(e.target.value)} />
        <button className="btn" onClick={load}>بحث</button>
      </div>
      {invoice && (
        <>
          <table className="grid">
            <thead><tr><th>الصنف</th><th>مبيع</th><th>مرتجع سابقاً</th><th>كمية المرتجع</th></tr></thead>
            <tbody>
              {invoice.lines.map((l: any) => {
                const vid = l.variantId ?? l.productId;
                const prev = invoice.returned?.find((r: any) => r.variantId === vid)?.qty ?? 0;
                return (
                  <tr key={l.id}>
                    <td>{l.variant?.product?.name ?? l.productId}{l.variant ? ` — ${l.variant.name}` : ''}</td>
                    <td>{l.qty}</td>
                    <td>{prev}</td>
                    <td><input type="number" min={0} max={l.qty - prev} value={qty[vid] ?? 0} onChange={(e) => setQty({ ...qty, [vid]: Number(e.target.value) })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row2">
            <Field label="رسوم إرجاع (أغورات)"><input type="number" min={0} value={fee} onChange={(e) => setFee(Number(e.target.value))} /></Field>
            <Field label="طريقة الرد">
              <select value={method} onChange={(e) => {
                const m = e.target.value;
                setMethod(m);
                if (m === 'bank') setRefundCode(banks[0]?.glAccountCode ?? '1100');
              }}>
                <option value="cash">نقد</option><option value="bank">بنك</option><option value="credit">حساب العميل</option>
              </select>
            </Field>
            {method === 'bank' && (
              <Field label="الحساب البنكي">
                <select value={refundCode} onChange={(e) => setRefundCode(e.target.value)}>
                  {sources.filter((s) => s.code !== '1000').map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
                </select>
              </Field>
            )}
            <button className="btn" onClick={submit}>تنفيذ المرتجع</button>
          </div>
        </>
      )}
    </div>
  );
}

function QuotesTab({ onToast, canConvert }: { onToast: (m: string, t?: 'ok' | 'bad') => void; canConvert: boolean }) {
  const [list, setList] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState(() => new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  const [lines, setLines] = useState<{ name: string; qty: number; priceAgora: number }[]>([]);
  const [payments, setPayments] = useState<{ method: string; accountCode: string; amountAgora: number }[]>([]);
  const { sources } = usePaySources(true);

  const load = () => api<any[]>('/sales/quotations').then(setList).catch((e) => onToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    if (!lines.length) { onToast('أضف أسطراً أولاً', 'bad'); return; }
    try {
      const variants = await Promise.all(lines.map(async (l) => {
        const s = await api<SearchRes>(`/catalog/search?branchId=${(await api<any[]>('/org/branches'))[0].id}&q=${encodeURIComponent(l.name)}`);
        const v = s.products[0]?.variants[0];
        if (!v) throw new Error(`لا متغير للصنف: ${l.name}`);
        return { variantId: v.id, qty: l.qty, unitPriceAgora: l.priceAgora };
      }));
      await api('/sales/quotations', { method: 'POST', body: { expiryDate: expiry, lines: variants } });
      onToast('أُنشئ عرض السعر');
      setLines([]); load();
    } catch (e) { onToast((e as Error).message, 'bad'); }
  };

  const act = async (id: string, action: 'renew' | 'cancel' | 'convert') => {
    try {
      if (action === 'renew') {
        const d = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
        await api(`/sales/quotations/${id}/renew`, { method: 'POST', body: { expiryDate: d } });
        onToast(`جُدد حتى ${d}`);
      } else if (action === 'cancel') {
        await api(`/sales/quotations/${id}/cancel`, { method: 'POST', body: {} });
        onToast('أُلغي العرض');
      } else {
        if (payments.length === 0) { onToast('أضف دفعة أولاً', 'bad'); return; }
        const res = await api<{ invoiceId: string }>(`/sales/quotations/${id}/convert`, { method: 'POST', body: { payments } });
        onToast(`تحوّل لفاتورة ${res.invoiceId.slice(0, 8)}`);
      }
      load();
    } catch (e) { onToast((e as Error).message, 'bad'); }
  };

  return (
    <div className="card">
      <h3>عروض الأسعار</h3>
      <div className="row2">
        <input placeholder="وصف الصنف" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="number" placeholder="كمية" style={{ width: 90 }} onChange={(e) => setName(name ? name : name)} />
      </div>
      <div className="row2">
        <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        <button className="btn secondary" onClick={() => setLines([...lines, { name, qty: 1, priceAgora: 0 }])} disabled={!name}>+ سطر</button>
      </div>
      <div className="row2 wrap">
        {payments.map((p, i) => (
          <span className="row2" key={i}>
            <select value={p.accountCode} onChange={(e) => {
              const code = e.target.value;
              setPayments(payments.map((x, j) => j === i ? { ...x, method: code === '1000' ? 'cash' : 'bank', accountCode: code } : x));
            }}>
              {sources.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
            <input type="number" placeholder={`دفعة ${i + 1} (أغورات)`} value={p.amountAgora} style={{ width: 140 }}
              onChange={(e) => setPayments(payments.map((x, j) => j === i ? { ...x, amountAgora: Number(e.target.value) } : x))} />
          </span>
        ))}
        <button className="btn secondary" onClick={() => setPayments([...payments, { method: 'cash', accountCode: '1000', amountAgora: 0 }])}>+ دفعة</button>
      </div>
      <table className="grid">
        <thead><tr><th>العرض</th><th>الزبون</th><th>الصلاحية</th><th>الحالة</th><th>إجراءات</th></tr></thead>
        <tbody>
          {list.map((qq) => (
            <tr key={qq.id}>
              <td>{qq.id.slice(0, 8)}</td>
              <td>{qq.customer?.name ?? '—'}</td>
              <td>{new Date(qq.expiryDate).toLocaleDateString('ar')}</td>
              <td><Badge tone={qq.status === 'open' ? 'ok' : qq.status === 'expired' ? 'warn' : 'bad'}>{qq.status === 'open' ? 'مفتوح' : qq.status === 'expired' ? 'منتهي' : qq.status === 'converted' ? 'محول' : 'ملغى'}</Badge></td>
              <td className="actions">
                {canConvert && qq.status !== 'converted' && qq.status !== 'cancelled' && (
                  <>
                    <button className="btn small" onClick={() => act(qq.id, 'convert')}>تحويل لفاتورة</button>
                    <button className="btn secondary small" onClick={() => act(qq.id, 'renew')}>تجديد</button>
                    <button className="btn secondary small" onClick={() => act(qq.id, 'cancel')}>إلغاء</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {lines.length > 0 && <button className="btn" onClick={create}>حفظ العرض ({lines.length} أسطر)</button>}
    </div>
  );
}
