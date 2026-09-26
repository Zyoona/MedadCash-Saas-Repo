import { useEffect, useMemo, useRef, useState } from 'react';
import { api, auditEvent, money } from '../api.js';
import { computeInvoice } from '@medad/shared-types';
import { Badge, DEFAULT_VARIANT, Field, Money, ProductImage, SplitAgora, Tabs, useToast } from '../ui.js';
import { useAuth } from '../auth.js';
import { bankLabel, CASH_CODE, PAY_METHODS, useBanks, usePaySources } from '../banks.js';

// POS (§Phase4): بحث اسم/SKU/باركود + خصم المنتج وفاتورة + ضريبة أخيراً + دفع متعدد
// + إرجاع الباقي بطريقة مختلفة (سالب) + مرتجعات + عروض أسعار — بنفس ترتيب الحساب الملزم.
// فواتير متوازية: يمكن فتح أكثر من فاتورة بيع لعدة زبائن في نفس الوقت والتنقل بينها.

const METHODS = PAY_METHODS.filter((m) => m.method !== 'credit');
const MAX_OPEN_INVOICES = 8;

interface SearchRes {
  products: { id: string; name: string; sku: string | null; imageUrl: string | null; thumbUrl: string | null; variants: { id: string; name: string; barcode: string }[]; branchData: { price: string }[] }[];
  unitMatch: { id: string; barcode: string | null; product: { id: string; name: string; imageUrl: string | null; thumbUrl: string | null; branchData: { price: string }[] } }[];
}
interface CartLine { productId: string; variantId: string | null; name: string; imageUrl: string | null; thumbUrl: string | null; qty: number; priceAgora: number; lineDiscountAgora: number }
interface Payment { method: string; accountCode: string; amountAgora: number }
interface Customer { id: string; name: string; isCashDefault: boolean }
/** وردية الكاشير المفتوحة + مطابقة الصندوق الحية (المتوقع من دفتر الأستاذ: درج العهدة أو حركة الفرع) */
interface ShiftInfo { id: string; openedAt: string; openingAmountAgora: number }
interface ShiftPanel {
  shift: ShiftInfo | null;
  expectedAgora: number | null;
  drawerAccountCode: string | null;
  basis: 'drawer' | 'branch_flow' | null;
  suggestedOpeningAgora: number | null;
  boxBalanceAgora: number;
  otherOpenShifts: number;
  warnings: string[];
}
interface ShiftCloseResult { expectedAgora: number; diffAgora: number; drawerAccountCode: string | null; entryId: string | null; warnings: string[] }
/** فاتورة بيع مفتوحة — لكل زبون سلته وخصوماته ودفعاته المستقلة */
interface SaleSession { id: string; no: number; customerId: string; cart: CartLine[]; invoiceDiscount: number; discountPct: number; payments: Payment[]; paymentsTouched: boolean }

export function Pos() {
  const { user } = useAuth();
  const [tab, setTab] = useState('sell');
  const [toast, showToast] = useToast();
  const [branchId, setBranchId] = useState('');
  const [shiftPanel, setShiftPanel] = useState<ShiftPanel | null>(null);
  const shift = shiftPanel?.shift ?? null;
  // تجاوز «صندوق الفرع واحد»: مدير/محاسب بصلاحية pos.shift_any يفتح وردية فوق وردية كاشير آخر
  const canShareBox = !!user?.perms.includes('pos.shift_any') || !!user?.perms.includes('*');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const sessionSeq = useRef(1);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const newSession = (): SaleSession => {
    const no = sessionSeq.current++;
    const cash = customers.find((c) => c.isCashDefault);
    return { id: `pos-${no}`, no, customerId: cash?.id ?? '', cart: [], invoiceDiscount: 0, discountPct: 0, payments: [], paymentsTouched: false };
  };

  const [sessions, setSessions] = useState<SaleSession[]>(() => [newSession()]);
  const [activeId, setActiveId] = useState<string>(() => sessions[0].id);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchRes | null>(null);
  const [taxBps, setTaxBps] = useState(0);
  const { banks } = useBanks(true);
  const defaultBankCode = banks[0]?.glAccountCode ?? '1100';

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];

  // بعد إغلاق أي فاتورة: تثبيت الفاتورة النشطة على أول فاتورة متاحة
  useEffect(() => {
    if (sessions.length && !sessions.some((s) => s.id === activeId)) setActiveId(sessions[0].id);
  }, [sessions, activeId]);

  // عند الدخول للصفحة وعند التنقل بين الفواتير المفتوحة: التركيز على خانة بحث اسم/SKU/باركود
  useEffect(() => {
    searchRef.current?.focus();
  }, [activeId]);

  useEffect(() => {
    api<any>('/org/branches').then((bs) => {
      const b = bs[0];
      if (b) setBranchId(b.id);
    });
    api<Customer[]>('/parties/customers').then((cs) => {
      setCustomers(cs);
      const cash = cs.find((c) => c.isCashDefault);
      if (cash) setSessions((ss) => ss.map((s) => (s.customerId ? s : { ...s, customerId: cash.id })));
    });
    api<Record<string, unknown>>('/settings').then((s) => {
      const rate = (s as { tax_rate?: { rateBps?: number } }).tax_rate;
      setTaxBps(rate?.rateBps ?? 0);
    });
  }, []);

  // لوحة الوردية: مرتبطة بفرع POS المختار (وليس فرع التوكن) حتى تتطابق مع فواتير الشاشة
  const loadShiftPanel = () => {
    if (!branchId) return;
    api<ShiftPanel>(`/sales/shifts/panel?branchId=${branchId}`).then(setShiftPanel).catch(() => setShiftPanel(null));
  };
  useEffect(() => {
    loadShiftPanel();
  }, [branchId]);

  const patchActive = (fn: (s: SaleSession) => SaleSession) => {
    setSessions((ss) => ss.map((s) => (s.id === activeId ? fn(s) : s)));
  };
  const patchLine = (index: number, patch: Partial<CartLine>) => {
    patchActive((s) => ({
      ...s,
      cart: s.cart.map((x, j) => {
        if (j !== index) return x;
        const next = { ...x, ...patch };
        // إعادة تقييد الخصم عند تغير الكمية/السعر حتى لا يتجاوز إجمالي السطر (وإلا فشل حساب الفاتورة)
        const gross = next.qty * next.priceAgora;
        if (gross >= 0 && next.lineDiscountAgora > gross) next.lineDiscountAgora = gross;
        return next;
      }),
    }));
  };
  const patchPayments = (fn: (ps: Payment[]) => Payment[]) => {
    // أي تعديل يدوي على الدفعات يوقف تتبع الدفعة النقدية الافتراضية لهذه الفاتورة
    patchActive((s) => ({ ...s, payments: fn(s.payments), paymentsTouched: true }));
  };

  const search = async (term: string) => {
    setQ(term);
    if (term.trim().length < 1) { setResults(null); return; }
    const r = await api<SearchRes>(`/catalog/search?branchId=${branchId}&q=${encodeURIComponent(term)}`);
    setResults(r);
    auditEvent('search', 'catalog');
    // باركود مباشر → أضف للسلة فوراً
    const exact = r.products.find((p) => p.variants.some((v) => v.barcode === term.trim()));
    if (exact) {
      addToCart(exact.id, exact.variants[0].id, exact.name, exact.imageUrl, exact.thumbUrl, Math.round(Number(exact.branchData[0]?.price ?? 0) * 100));
      setResults(null);
      setQ('');
    }
  };

  const addToCart = (productId: string, variantId: string | null, name: string, imageUrl: string | null, thumbUrl: string | null, priceAgora: number) => {
    patchActive((s) => {
      const existing = s.cart.find((l) => l.productId === productId && l.variantId === variantId && l.priceAgora === priceAgora);
      if (existing) return { ...s, cart: s.cart.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l)) };
      return { ...s, cart: [...s.cart, { productId, variantId, name, imageUrl, thumbUrl, qty: 1, priceAgora, lineDiscountAgora: 0 }] };
    });
  };

  const computeTotals = (s: SaleSession) => {
    const disc = s.discountPct > 0 ? Math.round((s.cart.reduce((sum, l) => sum + (l.qty * l.priceAgora - l.lineDiscountAgora), 0) * s.discountPct) / 100) : s.invoiceDiscount;
    try {
      return computeInvoice(
        s.cart.map((l) => ({ qty: l.qty, unitPriceAgora: l.priceAgora, lineDiscountAgora: l.lineDiscountAgora, taxRateBps: taxBps })),
        Math.max(0, disc),
      );
    } catch {
      // مدخلات غير مكتملة أثناء الكتابة — لا نُسقط الصفحة
      return null;
    }
  };

  const totals = useMemo(() => (active ? computeTotals(active) : null), [active, taxBps]);
  const paidNet = (active?.payments ?? []).reduce((s, p) => s + p.amountAgora, 0);
  const remainder = (totals?.grandTotalAgora ?? 0) - paidNet;

  // دفعة نقدية افتراضية بقيمة المبلغ النهائي — تتبع الإجمالي تلقائياً حتى يعدّل الكاشير الدفعات يدوياً
  useEffect(() => {
    if (!totals) return;
    const amount = totals.grandTotalAgora;
    setSessions((ss) => ss.map((s) => {
      if (s.id !== activeId || s.paymentsTouched) return s;
      const cur = s.payments;
      if (cur.length === 1 && cur[0].method === 'cash' && cur[0].accountCode === CASH_CODE && cur[0].amountAgora === amount) return s;
      return { ...s, payments: [{ method: 'cash', accountCode: CASH_CODE, amountAgora: amount }] };
    }));
  }, [totals, activeId]);

  const openNewSession = () => {
    if (sessions.length >= MAX_OPEN_INVOICES) {
      showToast(`الحد الأقصى ${MAX_OPEN_INVOICES} فواتير مفتوحة في نفس الوقت`, 'bad');
      return;
    }
    const s = newSession();
    setSessions((ss) => [...ss, s]);
    setActiveId(s.id);
  };

  const closeSession = (id: string) => {
    const target = sessions.find((x) => x.id === id);
    if (!target) return;
    if (target.cart.length > 0 && !window.confirm(`إغلاق فاتورة رقم ${target.no} سيُلغي أصنافها (${target.cart.length}) — متابعة؟`)) return;
    const fallback = newSession();
    setSessions((ss) => {
      const rest = ss.filter((x) => x.id !== id);
      return rest.length ? rest : [fallback];
    });
    if (target.cart.length > 0) showToast(`أُغلقت فاتورة رقم ${target.no} بدون حفظ`);
  };

  const checkout = async () => {
    if (!active || !totals) return;
    try {
      const res = await api<{ invoiceId: string; warnings: string[] }>('/sales/invoices', {
        method: 'POST',
        body: { branchId, customerId: active.customerId || null, shiftId: shift?.id ?? null, invoiceDiscountAgora: totals.invoiceDiscountAgora, lines: active.cart, payments: active.payments },
      });
      showToast(`تمت الفاتورة: ${res.invoiceId.slice(0, 8)}${res.warnings.length ? ' — ' + res.warnings.join('، ') : ''}`, res.warnings.length ? 'bad' : 'ok');
      // تحديث وظيفي: تعديلات الفواتير الأخرى أثناء انتظار الشبكة لا تُفقد
      const fallback = newSession();
      setSessions((ss) => {
        const rest = ss.filter((x) => x.id !== active.id);
        return rest.length ? rest : [fallback];
      });
      loadShiftPanel(); // تحديث «المتوقع» الحي لصندوق الوردية بعد ترحيل الفاتورة
    } catch (e) {
      showToast((e as Error).message, 'bad');
    }
  };

  // ─── الورديات ───
  // الافتتاح: تحويل عهدة نقدية من صندوق الفرع إلى درج الكاشير (Dr درج / Cr 1000).
  // الإقفال: عدّ فعلي مقابل رصيد الدرج من الدفتر، ويُرحَّل التسليم والفرق (5310) في قيد واحد.
  const openShift = async (openingAgora: number) => {
    try {
      const res = await api<{ warnings: string[] }>('/sales/shifts/open', { method: 'POST', body: { branchId, openingAmountAgora: openingAgora } });
      loadShiftPanel();
      showToast(res.warnings?.length ? `تم افتتاح الوردية — ${res.warnings.join('، ')}` : 'تم افتتاح الوردية', res.warnings?.length ? 'bad' : 'ok');
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };
  const closeShift = async (actualAgora: number) => {
    if (!shift) return;
    try {
      const rep = await api<ShiftCloseResult>(`/sales/shifts/${shift.id}/close`, { method: 'POST', body: { closingActualAgora: actualAgora } });
      const diff = rep.diffAgora ?? 0;
      const diffText = diff === 0 ? 'بلا فروق' : `${diff < 0 ? 'عجز' : 'فائض'} ${money(Math.abs(diff))}${rep.entryId ? ' — مُرحَّل 5310' : ''}`;
      const extra = rep.warnings?.length ? ` — ${rep.warnings.join('، ')}` : '';
      showToast(`أُقفلت الوردية — متوقع ${money(rep.expectedAgora)} / فعلي ${money(actualAgora)} / ${diffText}${extra}`, diff === 0 && !extra ? 'ok' : 'bad');
      loadShiftPanel();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div className="pos-page">
      {toast}
      <div className="pos-toolbar">
        <Tabs active={tab} onChange={setTab} tabs={[{ id: 'sell', label: 'بيع' }, { id: 'return', label: 'مرتجع' }, { id: 'quotes', label: 'عروض الأسعار' }]} />
        <ShiftBanner panel={shiftPanel} allowSharedBox={canShareBox} onOpen={openShift} onClose={closeShift} />
      </div>
      {tab === 'sell' && active && (
        <>
          {/* فواتير مفتوحة متزامنة — فاتورة لكل زبون */}
          <div className="pos-sessions">
            {sessions.map((s) => {
              const t = computeTotals(s);
              const cust = customers.find((c) => c.id === s.customerId);
              return (
                <div
                  key={s.id}
                  className={`pos-session${s.id === activeId ? ' active' : ''}`}
                  role="button" tabIndex={0}
                  title="التنقل بين الفواتير المفتوحة"
                  onClick={() => setActiveId(s.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setActiveId(s.id); }}
                >
                  <span className="pos-session-title">فاتورة {s.no}</span>
                  {cust && <span className="pos-session-cust">{cust.name}</span>}
                  <span className="pos-session-total">{t ? money(t.grandTotalAgora) : '—'}</span>
                  <button
                    className="pos-session-close" title="إغلاق هذه الفاتورة" aria-label={`إغلاق فاتورة ${s.no}`}
                    onClick={(e) => { e.stopPropagation(); closeSession(s.id); }}
                  >✕</button>
                </div>
              );
            })}
            <button className="btn secondary pos-session-add" onClick={openNewSession} title="فتح فاتورة بيع جديدة لزبون آخر">+ زبون جديد</button>
          </div>
          <div className="pos-grid">
            <div className="card pos-catalog">
              <div className="pos-catalog-head">
                <h3>الأصناف</h3>
                <div className="pos-search">
                  <input ref={searchRef} placeholder="بحث اسم / SKU / باركود..." value={q} onChange={(e) => void search(e.target.value)} />
                  {results && (
                    <div className="search-results">
                      {results.products.map((p) => {
                        const price = Math.round(Number(p.branchData[0]?.price ?? 0) * 100);
                        return p.variants.length > 0 ? p.variants.map((v) => {
                          const vName = v.name === DEFAULT_VARIANT ? '' : v.name;
                          return (
                          <button key={v.id} className="result-row" onClick={() => { addToCart(p.id, v.id, vName ? `${p.name} (${vName})` : p.name, p.imageUrl, p.thumbUrl, price); setResults(null); setQ(''); }}>
                            <span className="result-main"><ProductImage src={p.imageUrl} thumb={p.thumbUrl} alt={p.name} size={32} />{p.name}{vName ? ` — ${vName}` : ''} <small>{v.barcode}</small></span>
                            <strong>{money(price)}</strong>
                          </button>
                          );
                        }) : (
                          <button key={p.id} className="result-row" disabled={p.branchData.length === 0} onClick={() => { addToCart(p.id, null, p.name, p.imageUrl, p.thumbUrl, price); setResults(null); setQ(''); }}>
                            <span className="result-main"><ProductImage src={p.imageUrl} thumb={p.thumbUrl} alt={p.name} size={32} />{p.name}</span>
                            <strong>{money(price)}</strong>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div className="pos-scroll">
                <table className="grid">
                  <thead><tr><th>الصنف</th><th>كمية</th><th>السعر</th><th>خصم المنتج</th><th>إجمالي</th><th></th></tr></thead>
                  <tbody>
                    {active.cart.map((l, i) => (
                      <tr key={i}>
                        <td><span className="cell-with-img"><ProductImage src={l.imageUrl} thumb={l.thumbUrl} alt={l.name} />{l.name}</span></td>
                        <td><input type="number" min={1} value={l.qty} onChange={(e) => patchLine(i, { qty: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} style={{ width: 64 }} /></td>
                        <td><SplitAgora agora={l.priceAgora} label="السعر" onAgora={(v) => patchLine(i, { priceAgora: v })} /></td>
                        <td><SplitAgora agora={l.lineDiscountAgora} label="خصم المنتج" onAgora={(v) => patchLine(i, { lineDiscountAgora: Math.min(v, l.qty * l.priceAgora) })} /></td>
                        <td>{money(l.qty * l.priceAgora - l.lineDiscountAgora)}</td>
                        <td><button className="btn secondary small" onClick={() => patchActive((s) => ({ ...s, cart: s.cart.filter((_, j) => j !== i) }))}>✕</button></td>
                      </tr>
                    ))}
                    {active.cart.length === 0 && <tr><td colSpan={6}>السلة فارغة — ابحث وأضف الأصناف</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card pos-pay">
              <div className="pos-pay-head">
                <h3>الدفع — فاتورة {active.no}</h3>
                <select value={active.customerId} onChange={(e) => patchActive((s) => ({ ...s, customerId: e.target.value }))} aria-label="الزبون">
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isCashDefault ? ' (نقدي)' : ''}</option>)}
                </select>
              </div>
              <div className="row2 pos-discounts">
                <Field label="خصم فاتورة">
                  <SplitAgora
                    agora={active.discountPct > 0 ? 0 : active.invoiceDiscount}
                    disabled={active.discountPct > 0} label="خصم الفاتورة"
                    onAgora={(v) => patchActive((s) => ({ ...s, invoiceDiscount: Math.min(v, s.cart.reduce((sum, l) => sum + (l.qty * l.priceAgora - l.lineDiscountAgora), 0)) }))}
                  />
                </Field>
                <Field label="خصم %"><input type="number" min={0} max={100} value={active.discountPct} onChange={(e) => patchActive((s) => ({ ...s, discountPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) }))} /></Field>
              </div>
              <div className="totals">
                <div><span>بعد الخصومات</span><Money agora={totals?.taxableTotalAgora ?? null} /></div>
                <div><span>الضريبة ({taxBps / 100}%)</span><Money agora={totals?.taxTotalAgora ?? null} /></div>
                <div className="grand"><span>الإجمالي</span><Money agora={totals?.grandTotalAgora ?? null} /></div>
                <div><span>المدفوع</span><Money agora={paidNet} /></div>
                <div><span>{remainder > 0 ? 'آجل (ذمة)' : 'الباقي'}</span><Money agora={Math.abs(remainder)} /></div>
              </div>
              <div className="pos-pays">
                {active.payments.map((p, i) => (
                  <div className="pay-row" key={i}>
                    <select value={p.method} onChange={(e) => {
                      const m = METHODS.find((m) => m.method === e.target.value)!;
                      const code = m.method === 'bank' ? defaultBankCode : m.accountCode;
                      patchPayments((ps) => ps.map((x, j) => j === i ? { ...x, method: m.method, accountCode: code } : x));
                    }}>
                      {METHODS.map((m) => <option key={m.method} value={m.method}>{m.label}</option>)}
                    </select>
                    {p.method === 'bank' && (
                      <select value={p.accountCode} onChange={(e) => patchPayments((ps) => ps.map((x, j) => j === i ? { ...x, accountCode: e.target.value } : x))} aria-label="الحساب البنكي">
                        {banks.map((b) => <option key={b.glAccountCode} value={b.glAccountCode}>{bankLabel(b)}</option>)}
                      </select>
                    )}
                    <SplitAgora agora={p.amountAgora} label={`الدفعة ${i + 1}`} allowNegative onAgora={(v) => patchPayments((ps) => ps.map((x, j) => j === i ? { ...x, amountAgora: v } : x))} />
                    <button className="btn secondary small" onClick={() => patchPayments((ps) => ps.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
              </div>
              <div className="row2 pos-pay-actions">
                <button className="btn secondary" onClick={() => patchPayments((ps) => [...ps, { method: 'cash', accountCode: CASH_CODE, amountAgora: remainder > 0 ? remainder : 0 }])}>+ دفعة</button>
                <button className="btn secondary" onClick={() => patchPayments((ps) => [...ps, { method: 'bank', accountCode: defaultBankCode, amountAgora: remainder < 0 ? remainder : 0 }])}>+ إرجاع باقي</button>
              </div>
              <button className="btn wide" disabled={!totals || active.cart.length === 0 || remainder < 0} onClick={checkout}>إتمام البيع — فاتورة {active.no}</button>
            </div>
          </div>
        </>
      )}
      {tab === 'return' && <div className="pos-alt"><ReturnTab onToast={showToast} /></div>}
      {tab === 'quotes' && <div className="pos-alt"><QuotesTab onToast={showToast} canConvert={!!user?.perms.includes('quotations.manage') || !!user?.perms.includes('*')} /></div>}
    </div>
  );
}

/**
 * شريط الوردية (§Phase4) — درج عهدة مستقل لكل كاشير (حساب GL أصلي 1010+):
 *  - بلا وردية: «صندوق الفرع» = رصيد 1000 للفرع من الدفتر، وحقل افتتاح = عدّ النقد المُحوَّل
 *    إلى الدرج (يُقترح من العدّ الفعلي لإقفال الكاشير السابق). الافتتاح يرحّل Dr درج / Cr 1000.
 *  - وردية مفتوحة: «المتوقع» = رصيد حساب الدرج من الدفتر، وحقل الفعلي للعدّ عند الإقفال؛
 *    الإقفال يرحّل Dr 1000 (المُسلَّم) + Dr/Cr 5310 (العجز/الفائض) / Cr درج ⇒ الدرج يعود صفراً.
 */
function ShiftBanner({ panel, allowSharedBox, onOpen, onClose }: { panel: ShiftPanel | null; allowSharedBox: boolean; onOpen: (n: number) => void; onClose: (n: number) => void }) {
  const shift = panel?.shift ?? null;
  const expected = panel?.expectedAgora ?? 0;
  const [opening, setOpening] = useState(0);
  const [actual, setActual] = useState(0);
  // اقتراح مبلغ الافتتاح من آخر إقفال لنفس الكاشير/الفرع (ترحيل العهدة بدل إعادة الإدخال)
  useEffect(() => {
    if (!shift && panel?.suggestedOpeningAgora != null) setOpening(panel.suggestedOpeningAgora);
  }, [shift?.id, panel?.suggestedOpeningAgora]);
  // تعبئة العدّ الفعلي بالمتوقع عند التعرف على الوردية (يعدّله الكاشير بعد العدّ الحقيقي)
  useEffect(() => {
    setActual(expected);
  }, [shift?.id]);
  const diff = actual - expected;
  // صندوق الفرع واحد: لا تُفتح وردية ثانية فوق وردية كاشير آخر إلا بصلاحية pos.shift_any
  const blockedBySharedBox = (panel?.otherOpenShifts ?? 0) > 0 && !allowSharedBox;
  const boxCaption = <span className="shift-caption" title="رصيد حساب الصندوق (1000) لفرع POS من دفتر الأستاذ">صندوق الفرع {money(panel?.boxBalanceAgora ?? 0)}</span>;
  const expectedTitle = panel?.basis === 'drawer'
    ? 'رصيد حساب درج العهدة من دفتر الأستاذ = العهدة المحوَّلة عند الافتتاح + النقد المرحَّل إلى الدرج'
    : 'الافتتاح + صافي حركة حساب الصندوق (1000) لفرع الوردية من دفتر الأستاذ';

  if (shift) {
    return (
      <div className="shift-banner open">
        <span className="shift-status">وردية مفتوحة · {new Date(shift.openedAt).toLocaleTimeString('ar')}</span>
        {panel?.drawerAccountCode && <span className="shift-caption" title="حساب GL لدرج عهدة الكاشير">درج {panel.drawerAccountCode}</span>}
        <span className="shift-caption" title={expectedTitle}>المتوقع {money(expected)}</span>
        {boxCaption}
        <span className="shift-amount"><span className="shift-caption">الفعلي (عدّ)</span><SplitAgora agora={actual} onAgora={setActual} label="الفعلي" /></span>
        {diff !== 0 && <span className={`shift-diff ${diff < 0 ? 'short' : 'over'}`}>{diff < 0 ? 'عجز' : 'فائض'} {money(Math.abs(diff))}</span>}
        <button className="btn small" onClick={() => onClose(actual)}>إقفال</button>
      </div>
    );
  }
  return (
    <div className="shift-banner">
      <span className="shift-status">لا وردية مفتوحة</span>
      {boxCaption}
      {blockedBySharedBox && <span className="shift-caption shift-blocked" title="صندوق الفرع واحد — يجب إقفال وردية الكاشير الآخر قبل افتتاح وردية جديدة">وردية أخرى مفتوحة في الفرع</span>}
      <span className="shift-amount"><span className="shift-caption">افتتاح (عدّ)</span><SplitAgora agora={opening} onAgora={setOpening} label="الافتتاح" disabled={blockedBySharedBox} /></span>
      <button className="btn small" disabled={blockedBySharedBox} onClick={() => onOpen(opening)}>افتتاح</button>
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
          refundAccountCode: method === 'bank' ? refundCode : PAY_METHODS.find((m) => m.method === method)?.accountCode ?? '1000',
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
                    <td>
                      <span className="cell-with-img">
                        <ProductImage src={l.variant?.product?.imageUrl} thumb={l.variant?.product?.thumbUrl} alt={l.variant?.product?.name ?? 'صنف'} />
                        {l.variant?.product?.name ?? l.productId}{l.variant ? ` — ${l.variant.name}` : ''}
                      </span>
                    </td>
                    <td>{l.qty}</td>
                    <td>{prev}</td>
                    <td><input type="number" min={0} max={l.qty - prev} value={qty[vid] ?? 0} onChange={(e) => setQty({ ...qty, [vid]: Number(e.target.value) })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row2">
            <Field label="رسوم إرجاع"><SplitAgora agora={fee} onAgora={setFee} label="رسوم الإرجاع" /></Field>
            <Field label="طريقة الرد">
              <select value={method} onChange={(e) => {
                const m = e.target.value;
                setMethod(m);
                if (m === 'bank') setRefundCode(banks[0]?.glAccountCode ?? '1100');
              }}>
                {PAY_METHODS.filter((m) => m.method !== 'check').map((m) => <option key={m.method} value={m.method}>{m.label}</option>)}
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
              setPayments(payments.map((x, j) => j === i ? { ...x, method: PAY_METHODS.find((pm) => pm.accountCode === code)?.method ?? 'bank', accountCode: code } : x));
            }}>
              {sources.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
            <SplitAgora agora={p.amountAgora} label={`دفعة ${i + 1}`} onAgora={(v) => setPayments(payments.map((x, j) => j === i ? { ...x, amountAgora: v } : x))} />
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
