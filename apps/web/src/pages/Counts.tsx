import { useEffect, useMemo, useRef, useState } from 'react';
import { api, money } from '../api.js';
import { Badge, ProductImage, Tabs, useToast } from '../ui.js';

// الجرد (§Phase5): أولي (مقابل أرصدة افتتاحية 3900) / يومي (مقابل تسويات الجرد 5200).
// وضعان للإدخال: يدوي (جدول كل الأصناف) أو قارئ باركود (كل مسح = +1 وحدة للصنف).

interface StockRow { id: string; name: string; imageUrl: string | null; thumbUrl: string | null; totalQty: number; costAgora: number | null; variants: { id: string; name: string; barcode: string }[] }

type ScanInfo = { ok: true; name: string; barcode: string; counted: number; expected: number } | { ok: false; barcode: string } | null;

export function Counts() {
  const [type, setType] = useState<'initial' | 'daily'>('daily');
  const [mode, setMode] = useState<'manual' | 'scan'>('manual');
  const [stock, setStock] = useState<StockRow[]>([]);
  const [counted, setCounted] = useState<Record<string, number>>({});
  const [history, setHistory] = useState<any[]>([]);
  const [result, setResult] = useState<any>(null);
  const [code, setCode] = useState('');
  const [lastScan, setLastScan] = useState<ScanInfo>(null);
  const [toast, showToast] = useToast();
  const scanRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<'manual' | 'scan'>(mode);
  modeRef.current = mode;

  useEffect(() => {
    api<StockRow[]>('/inventory/stock').then(setStock).catch((e) => showToast((e as Error).message, 'bad'));
    api<any[]>('/ops/counts').then(setHistory).catch(() => undefined);
  }, []);

  // خريطة الباركود → الصنف (كل باركود متغير يُحسب للصنف كاملاً — الجرد على مستوى الصنف)
  const byBarcode = useMemo(() => {
    const m = new Map<string, StockRow>();
    for (const p of stock) for (const v of p.variants) if (v.barcode) m.set(v.barcode, p);
    return m;
  }, [stock]);

  // عند دخول وضع القارئ: التركيز على خانة المسح
  useEffect(() => {
    if (mode === 'scan') scanRef.current?.focus();
  }, [mode]);

  // القارئ يكتب في العنصر المركّز عليه — نعيد التركيز تلقائياً إذا سقط التركيز على لا شيء
  const onScanBlur = () => {
    window.setTimeout(() => {
      if (modeRef.current !== 'scan') return;
      const el = document.activeElement;
      if (!el || el === document.body) scanRef.current?.focus();
    }, 150);
  };

  const handleScan = () => {
    const bc = code.trim();
    if (!bc) return;
    const p = byBarcode.get(bc);
    if (!p) {
      setLastScan({ ok: false, barcode: bc });
      showToast(`باركود غير معروف: ${bc}`, 'bad');
      setCode('');
      scanRef.current?.focus();
      return;
    }
    const next = (counted[p.id] ?? 0) + 1;
    setCounted({ ...counted, [p.id]: next });
    setLastScan({ ok: true, name: p.name, barcode: bc, counted: next, expected: p.totalQty });
    setCode('');
    scanRef.current?.focus();
  };

  const submit = async () => {
    const lines = Object.entries(counted).map(([productId, countedQty]) => ({ productId, countedQty }));
    if (!lines.length) { showToast('أدخل كميات أولاً', 'bad'); return; }
    try {
      const res = await api<any>('/ops/counts', { method: 'POST', body: { type, notes: `جرد ${type === 'initial' ? 'أولي' : 'يومي'}`, lines } });
      setResult(res);
      showToast(`سُجل الجرد — فرق القيمة: ${res.netAdjustmentAgora} أغورات (قيد: ${res.entryId ?? 'لا فروق'})`);
      api<any[]>('/ops/counts').then(setHistory);
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const scanned = stock.filter((p) => counted[p.id] !== undefined);
  const scannedUnits = scanned.reduce((s, p) => s + (counted[p.id] ?? 0), 0);

  return (
    <div className="card">
      {toast}
      <div className="row-between">
        <h2>الجرد — العد الفعلي مقابل المتوقع</h2>
        <select value={type} onChange={(e) => setType(e.target.value as never)}>
          <option value="daily">يومي (تسويات 5200)</option>
          <option value="initial">أولي (أرصدة افتتاحية 3900)</option>
        </select>
      </div>
      <Tabs
        tabs={[{ id: 'manual', label: 'يدوي (جدول)' }, { id: 'scan', label: 'قارئ الباركود' }]}
        active={mode}
        onChange={(id) => setMode(id as 'manual' | 'scan')}
      />
      {mode === 'scan' && (
        <div className="scan-panel">
          <form className="scan-box" onSubmit={(e) => { e.preventDefault(); handleScan(); }}>
            <input
              ref={scanRef}
              dir="ltr"
              className="mono"
              placeholder="امسح الباركود هنا… (كل مسح = +1)"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onBlur={onScanBlur}
              autoComplete="off"
            />
            <button className="btn" type="submit">تسجيل</button>
          </form>
          {lastScan && (lastScan.ok ? (
            <div className="alert ok-alert">
              ✓ {lastScan.name} — المعدود الآن <strong>{lastScan.counted}</strong> (المتوقع {lastScan.expected}) · <span className="mono">{lastScan.barcode}</span>
            </div>
          ) : (
            <div className="alert bad">
              ✕ باركود غير معروف: <span className="mono">{lastScan.barcode}</span> — تأكد من الصنف أو أضفه أولاً من صفحة الأصناف
            </div>
          ))}
          {scanned.length > 0 && (
            <>
              <p className="scan-stats muted">
                أصناف ممسوحة: <strong>{scanned.length}</strong> · إجمالي الوحدات المعدودة: <strong>{scannedUnits}</strong>
              </p>
              <table className="grid">
                <thead><tr><th>الصنف</th><th>المتوقع</th><th>المعدود</th><th>الفرق</th><th></th></tr></thead>
                <tbody>
                  {scanned.map((p) => (
                    <tr key={p.id}>
                      <td><span className="cell-with-img"><ProductImage src={p.imageUrl} thumb={p.thumbUrl} alt={p.name} />{p.name}</span></td>
                      <td>{p.totalQty}</td>
                      <td><input type="number" min={0} value={counted[p.id] ?? ''} onChange={(e) => setCounted({ ...counted, [p.id]: Number(e.target.value) })} style={{ width: 90 }} /></td>
                      <td>{counted[p.id] !== undefined ? counted[p.id] - p.totalQty : '—'}</td>
                      <td><button className="btn secondary" title="إزالة من الجرد" onClick={() => setCounted(Object.fromEntries(Object.entries(counted).filter(([id]) => id !== p.id)))}>✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {scanned.length === 0 && <p className="muted">ابدأ بمسح الأصناف بجهاز الباركود — كل مسح يضيف وحدة واحدة. للكميات الكبيرة عدّل الرقم من الجدول بعد أول مسح.</p>}
        </div>
      )}
      {mode === 'manual' && (
        <table className="grid">
          <thead><tr><th>الصنف</th><th>المتوقع</th><th>المعدود</th><th>الفرق</th></tr></thead>
          <tbody>
            {stock.map((p) => (
              <tr key={p.id}>
                <td><span className="cell-with-img"><ProductImage src={p.imageUrl} thumb={p.thumbUrl} alt={p.name} />{p.name}</span></td>
                <td>{p.totalQty}</td>
                <td><input type="number" min={0} value={counted[p.id] ?? ''} onChange={(e) => setCounted({ ...counted, [p.id]: Number(e.target.value) })} style={{ width: 90 }} /></td>
                <td>{counted[p.id] !== undefined ? counted[p.id] - p.totalQty : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button className="btn" onClick={submit}>ترحيل الجرد + القيود</button>
      {result && (
        <div className="alert ok-alert">
          صافي فرق القيمة: <strong>{result.netAdjustmentAgora / 100} ₪</strong> — قيد: <span className="mono">{result.entryId ?? 'بلا فروق'}</span>
        </div>
      )}
      <h4>سجل الجردات</h4>
      <table className="grid">
        <thead><tr><th>النوع</th><th>الفرع</th><th>الأسطر</th><th>التاريخ</th></tr></thead>
        <tbody>
          {history.map((c) => (
            <tr key={c.id}>
              <td><Badge tone={c.type === 'initial' ? 'warn' : 'ok'}>{c.type === 'initial' ? 'أولي' : 'يومي'}</Badge></td>
              <td>{c.branch?.name ?? '—'}</td>
              <td>{c.lines.length}</td>
              <td>{new Date(c.createdAt).toLocaleString('ar')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
