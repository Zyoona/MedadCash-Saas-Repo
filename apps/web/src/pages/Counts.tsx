import { useEffect, useState } from 'react';
import { api, money } from '../api.js';
import { Badge, Field, ProductImage, useToast } from '../ui.js';

// الجرد (§Phase5): أولي (مقابل أرصدة افتتاحية 3900) / يومي (مقابل تسويات الجرد 5200).

interface StockRow { id: string; name: string; imageUrl: string | null; thumbUrl: string | null; totalQty: number; costAgora: number | null; variants: { id: string; name: string }[] }

export function Counts() {
  const [type, setType] = useState<'initial' | 'daily'>('daily');
  const [stock, setStock] = useState<StockRow[]>([]);
  const [counted, setCounted] = useState<Record<string, number>>({});
  const [history, setHistory] = useState<any[]>([]);
  const [result, setResult] = useState<any>(null);
  const [toast, showToast] = useToast();

  useEffect(() => {
    api<StockRow[]>('/inventory/stock').then(setStock).catch((e) => showToast((e as Error).message, 'bad'));
    api<any[]>('/ops/counts').then(setHistory).catch(() => undefined);
  }, []);

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
