import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { code128Svg } from '../barcode.js';
import { auditEvent, money } from '../api.js';
import { Field, DEFAULT_VARIANT, useToast } from '../ui.js';

// الملصقات: بحث تراكمي + تحديد (فردي/الكل) + سعر مشطوب لكل عنصر + خيارات إظهار + اسم مكتبة + طباعة.

interface Found { products: { id: string; name: string; sku: string | null; brand: { name: string } | null; category: { name: string } | null; variants: { id: string; name: string; barcode: string }[]; branchData: { price: string }[] }[] }

interface Row {
  key: string; // barcode فريد
  name: string; barcode: string; priceAgora: number; variant: string; brand: string;
}

const SIZES = {
  '40×30': { w: 400, h: 300, scale: 0.55 },
  '50×25': { w: 500, h: 250, scale: 0.5 },
  'A4 (24 شبكة)': { w: 300, h: 180, scale: 0.35 },
};

// وجهة الطباعة: ورق عادي (نافذة الطباعة العادية) أو طابعة ملصقات حرارية (صفحة بمقاس الملصق، ملصق لكل صفحة).
type PrinterMode = 'sheet' | 'thermal';

export function Labels() {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Row[]>([]);
  const [branchId, setBranchId] = useState<string>('');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, number>>({});
  const [oldPrice, setOldPrice] = useState<Record<string, number>>({});
  const [size, setSize] = useState<keyof typeof SIZES>('40×30');
  const [printer, setPrinter] = useState<PrinterMode>(() => (localStorage.getItem('medad_labels_printer') === 'thermal' ? 'thermal' : 'sheet'));
  const [libraryName, setLibraryName] = useState(() => localStorage.getItem('medad_labels_library') ?? '');
  // عناصر الملصق القابلة للإظهار/الإخفاء (الباركود نفسه دائماً ظاهر)
  const [show, setShow] = useState({ name: true, variant: true, brand: true, library: false, price: true, old: true, code: true });
  const [toast, showToast] = useToast();
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => { auditEvent('view', 'labels'); }, []);
  useEffect(() => {
    // صنف أُنشئ حديثاً من صفحة المخزون → يُضاف جاهزاً للطباعة (محدد، عدد 1).
    const raw = sessionStorage.getItem('medad_labels_seed');
    if (raw) {
      sessionStorage.removeItem('medad_labels_seed');
      try {
        const rows: Row[] = JSON.parse(raw);
        if (Array.isArray(rows) && rows.length > 0) {
          setItems((prev) => {
            const seen = new Set(prev.map((p) => p.key));
            return [...prev, ...rows.filter((r) => r?.key && !seen.has(r.key))];
          });
          setChecked((prev) => {
            const next = { ...prev };
            for (const r of rows) if (r?.key) next[r.key] = true;
            return next;
          });
        }
      } catch { /* بذرة غير صالحة — تُتجاهل */ }
    }
  }, []);
  useEffect(() => {
    api<any[]>('/org/branches').then((bs) => setBranchId(bs[0]?.id ?? '')).catch(() => undefined);
    api<{ name?: string }>('/org/tenant').then((t) => {
      if (t?.name && !localStorage.getItem('medad_labels_library')) setLibraryName(t.name);
    }).catch(() => undefined);
  }, []);

  useEffect(() => { localStorage.setItem('medad_labels_library', libraryName); }, [libraryName]);
  useEffect(() => { localStorage.setItem('medad_labels_printer', printer); }, [printer]);

  const changePrinter = (m: PrinterMode) => {
    setPrinter(m);
    // مقاس شبكة A4 خاص بالورق العادي — عند التحويل لطابعة الملصقات نرتّج لمقاس ملصق حقيقي.
    if (m === 'thermal' && size === 'A4 (24 شبكة)') setSize('40×30');
  };

  const search = (term: string) => {
    setQ(term);
    window.clearTimeout(timer.current);
    if (term.trim().length < 2) return;
    timer.current = window.setTimeout(async () => {
      try {
        const bid = branchId || (await api<any[]>('/org/branches'))[0]?.id;
        if (!bid) return;
        const r = await api<Found>(`/ops/labels/products?branchId=${bid}&q=${encodeURIComponent(term.trim())}`);
        const rows: Row[] = r.products.flatMap((p) => p.variants.map((v) => ({
          key: v.barcode,
          name: p.name, barcode: v.barcode, variant: v.name === DEFAULT_VARIANT ? '' : v.name,
          priceAgora: Math.round(Number(p.branchData[0]?.price ?? 0) * 100),
          brand: p.brand?.name ?? '',
        })));
        setItems((prev) => {
          const seen = new Set(prev.map((p) => p.key));
          return [...prev, ...rows.filter((row) => !seen.has(row.key))];
        });
      } catch (e) { showToast((e as Error).message, 'bad'); }
    }, 350);
  };

  const clearResults = () => { setItems([]); setChecked({}); setQty({}); setOldPrice({}); setQ(''); };

  const allChecked = items.length > 0 && items.every((it) => checked[it.key]);
  const toggleAll = (v: boolean) => {
    const next: Record<string, boolean> = { ...checked };
    for (const it of items) next[it.key] = v;
    setChecked(next);
  };

  const setAllQty = (n: number) => {
    const next: Record<string, number> = { ...qty };
    for (const it of items) if (checked[it.key]) next[it.key] = n;
    setQty(next);
  };

  const labels: (Row & { n: number; old: number })[] = [];
  for (const it of items) {
    if (!checked[it.key]) continue;
    const n = Math.max(0, Math.floor(qty[it.key] ?? 1));
    for (let i = 0; i < n; i++) labels.push({ ...it, n: 0, old: oldPrice[it.key] ?? 0 });
  }

  const cfg = SIZES[size];

  // طباعة حرارية: نستنسخ معاينة الملصقات إلى إطار مخفي بمستند مستقل حجم صفحته = مقاس الملصق بالمليمتر
  // (40×30 → 40mm×30mm)، وملصق واحد لكل صفحة (page-break) — مع color-adjust حتى تخرج خطوط الباركود صلبة.
  const printThermal = () => {
    const wmm = cfg.w / 10;
    const hmm = cfg.h / 10;
    const nodes = Array.from(document.querySelectorAll<HTMLDivElement>('#labels-print-area .label-card'));
    if (nodes.length === 0) return;
    const cards = nodes.map((n) => n.outerHTML).join('\n');
    const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>ملصقات ${wmm}×${hmm}</title><style>
@page { size: ${wmm}mm ${hmm}mm; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; }
.label-card {
  box-sizing: border-box; width: ${wmm}mm !important; height: ${hmm}mm !important; padding: 1mm 1.2mm;
  overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 0.2mm; background: #fff; color: #000; text-align: center;
  page-break-after: always; break-after: page;
}
.label-card:last-child { page-break-after: auto; break-after: auto; }
.label-library { font-weight: 800; font-size: 2.6mm; line-height: 1.15; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.label-name { font-weight: 700; font-size: 2.3mm; line-height: 1.2; text-align: center; max-width: 100%; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.label-brand { font-size: 2mm; color: #222; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.label-old { text-decoration: line-through; font-size: 2.1mm; color: #333; line-height: 1.15; }
.label-price { font-weight: 800; font-size: 3mm; line-height: 1.15; }
.label-bars { width: 100%; max-width: 100%; overflow: hidden; display: flex; justify-content: center; }
.label-bars svg { display: block; width: 100%; max-width: 100%; height: auto; max-height: ${(hmm * 0.3).toFixed(1)}mm; }
.label-code { font-size: 2mm; color: #000; letter-spacing: 0.3mm; direction: ltr; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style></head><body>${cards}</body></html>`;
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;';
    document.body.appendChild(frame);
    const win = frame.contentWindow;
    if (!win) { frame.remove(); return; }
    const doc = win.document;
    doc.open();
    doc.write(html);
    doc.close();
    window.setTimeout(() => {
      try { win.focus(); win.print(); } finally { window.setTimeout(() => frame.remove(), 2000); }
    }, 150);
  };

  const doPrint = () => {
    if (labels.length === 0) return;
    void auditEvent('print', 'labels');
    if (printer === 'thermal') printThermal();
    else window.print();
  };

  const toggle = (k: keyof typeof show, label: string) => (
    <label className="switch" key={k}>
      <input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} />
      <span className="track" aria-hidden="true" />
      <span className="switch-label">{label}</span>
    </label>
  );

  return (
    <div className="card labels-page">
      {toast}
      <h2>ملصقات وباركود</h2>
      <div className="row2 wrap no-print">
        <input placeholder="بحث صنف... (يتراكم)" value={q} onChange={(e) => void search(e.target.value)} style={{ width: 260 }} />
        <button className="btn secondary" onClick={clearResults}>مسح النتائج</button>
        <Field label="الحجم">
          <select value={size} onChange={(e) => setSize(e.target.value as never)}>
            {Object.keys(SIZES).filter((k) => printer === 'sheet' || k !== 'A4 (24 شبكة)').map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </Field>
        <Field label="الطابعة">
          <select value={printer} onChange={(e) => changePrinter(e.target.value as PrinterMode)}>
            <option value="sheet">ورق عادي (A4)</option>
            <option value="thermal">طابعة ملصقات (حرارية)</option>
          </select>
        </Field>
        <Field label="اسم المكتبة (يُطبع في الملصق)">
          <input placeholder="مثال: مكتبة مداد" value={libraryName} onChange={(e) => setLibraryName(e.target.value)} style={{ width: 180 }} />
        </Field>
        <button className="btn" onClick={doPrint} disabled={labels.length === 0}>طباعة ({labels.length})</button>
      </div>

      {printer === 'thermal' && (
        <p className="muted no-print">
          عند الطباعة اختر طابعة الملصقات في نافذة الطباعة، وتأكد أن مقاس الورق في إعدادات الطابعة يطابق مقاس الملصق
          ({cfg.w / 10}×{cfg.h / 10} مم)، والتكبير 100%، وإلغاء الترويسة والتذييل. كل ملصق يُطبع في صفحة مستقلة.
        </p>
      )}

      <fieldset className="no-print labels-opts">
        <legend>عناصر الملصق</legend>
        <div className="row2 wrap labels-switches">
          {toggle('library', 'المكتبة')}
          {toggle('name', 'اسم الصنف')}
          {toggle('variant', 'النوع/المتغير')}
          {toggle('brand', 'الماركة')}
          {toggle('price', 'السعر')}
          {toggle('old', 'السعر المشطوب')}
          {toggle('code', 'رقم الباركود')}
        </div>
        <p className="muted">الباركود (الخطوط) يُطبع دائماً ولا يمكن إخفاؤه.</p>
      </fieldset>

      <table className="grid no-print">
        <thead>
          <tr>
            <th><input type="checkbox" checked={allChecked} onChange={(e) => toggleAll(e.target.checked)} title="تحديد الكل" /></th>
            <th>الصنف</th><th>الباركود</th><th>السعر</th><th>سعر مشطوب</th><th>العدد</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.key} className={checked[it.key] ? 'picked' : ''}>
              <td><input type="checkbox" checked={!!checked[it.key]} onChange={(e) => setChecked({ ...checked, [it.key]: e.target.checked })} /></td>
              <td>{it.name} — {it.variant}</td>
              <td className="mono">{it.barcode}</td>
              <td>{money(it.priceAgora)}</td>
              <td>
                <input
                  type="number" min={0} placeholder="—" title="سعر مشطوب لهذا الصنف (بالشيكل)"
                  value={oldPrice[it.key] ?? ''}
                  onChange={(e) => setOldPrice({ ...oldPrice, [it.key]: Number(e.target.value) })}
                  style={{ width: 90 }}
                />
              </td>
              <td>
                <input
                  type="number" min={0}
                  value={qty[it.key] ?? 1}
                  onChange={(e) => setQty({ ...qty, [it.key]: Number(e.target.value) })}
                  style={{ width: 70 }}
                />
              </td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={6} className="muted">ابحث بجزء من الاسم أو الباركود — النتائج تتراكم هنا.</td></tr>}
        </tbody>
      </table>
      {items.length > 0 && (
        <div className="row2 no-print">
          <button className="btn secondary small" onClick={() => toggleAll(true)}>تحديد الكل</button>
          <button className="btn secondary small" onClick={() => toggleAll(false)}>إلغاء التحديد</button>
          <button className="btn secondary small" onClick={() => setAllQty(1)}>العدد 1 للمحدد</button>
          <button className="btn secondary small" onClick={() => setAllQty(5)}>العدد 5 للمحدد</button>
        </div>
      )}

      <h4 className="no-print">معاينة ({labels.length})</h4>
      <div className="labels-sheet" id="labels-print-area">
        {labels.map((l, i) => (
          <div key={i} className="label-card" style={{ width: cfg.w * cfg.scale, height: cfg.h * cfg.scale }}>
            {show.library && libraryName.trim() && <div className="label-library">{libraryName.trim()}</div>}
            {show.name && <div className="label-name">{l.name}{show.variant && l.variant ? ` — ${l.variant}` : ''}</div>}
            {!show.name && show.variant && <div className="label-name">{l.variant}</div>}
            {show.brand && l.brand && <div className="label-brand">{l.brand}</div>}
            {show.old && l.old > 0 && <div className="label-old">{money(Math.round(l.old * 100))}</div>}
            {show.price && <div className="label-price">{money(l.priceAgora)}</div>}
            <div
              className="label-bars"
              style={{ width: '100%', maxWidth: '100%' }}
              dangerouslySetInnerHTML={{ __html: code128Svg(l.barcode, 36, 1.4) }}
            />
            {show.code && <div className="label-code mono">{l.barcode}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
