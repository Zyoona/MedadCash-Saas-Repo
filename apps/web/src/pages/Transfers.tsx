import { useEffect, useState } from 'react';
import { api, money } from '../api.js';
import { Badge, Field, useToast } from '../ui.js';

interface TransferRow { id: string; status: string; fromBranch: { name: string }; toBranch: { name: string }; lines: { id: string; variantId: string; qty: number; costAgora: number }[] }

export function Transfers() {
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [branches, setBranches] = useState<any[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lines, setLines] = useState<{ variantName: string; qty: number }[]>([]);
  const [toast, showToast] = useToast();

  const load = () => {
    api<TransferRow[]>('/ops/transfers').then(setRows).catch((e) => showToast((e as Error).message, 'bad'));
    api<any[]>('/org/branches').then((bs) => {
      setBranches(bs);
      if (bs[0]) setFrom(bs[0].id);
      if (bs[1]) setTo(bs[1].id);
    });
  };
  useEffect(load, []);

  const create = async () => {
    try {
      const resolved = await Promise.all(lines.map(async (l) => {
        const s = await api<any>(`/catalog/search?branchId=${from}&q=${encodeURIComponent(l.variantName)}`);
        const v = s.products[0]?.variants[0];
        if (!v) throw new Error(`لا متغير: ${l.variantName}`);
        return { variantId: v.id, qty: l.qty };
      }));
      const res = await api<any>('/ops/transfers', { method: 'POST', body: { fromBranchId: from, toBranchId: to, lines: resolved } });
      showToast(`صدر التحويل — قيمة قيد النقل: ${money(res.totalCostAgora)}${res.warnings.length ? ' — ' + res.warnings.join('، ') : ''}`);
      setLines([]); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const receive = async (id: string) => {
    try {
      const res = await api<any>(`/ops/transfers/${id}/receive`, { method: 'POST', body: {} });
      showToast(`استُلم في الفرع الثاني — ${money(res.totalCostAgora)}`);
      load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div className="card">
      {toast}
      <h2>نقل بين الفروع — الخصم فوري والكمية لا تضيع (حساب 1410)</h2>
      <div className="row2 wrap">
        <Field label="من فرع">
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <Field label="إلى فرع">
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
      </div>
      {lines.map((l, i) => (
        <div className="row2" key={i}>
          <input placeholder="اسم الصنف (باركود)" value={l.variantName} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, variantName: e.target.value } : x))} />
          <input type="number" min={1} value={l.qty} style={{ width: 90 }} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: Number(e.target.value) } : x))} />
          <button className="btn secondary small" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div className="row2">
        <button className="btn secondary" onClick={() => setLines([...lines, { variantName: '', qty: 1 }])}>+ سطر</button>
        <button className="btn" onClick={create} disabled={lines.length === 0 || from === to}>إصدار التحويل</button>
      </div>
      <table className="grid">
        <thead><tr><th>من</th><th>إلى</th><th>أسطر</th><th>الحالة</th><th></th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>{t.fromBranch.name}</td>
              <td>{t.toBranch.name}</td>
              <td>{t.lines.length}</td>
              <td><Badge tone={t.status === 'received' ? 'ok' : 'warn'}>{t.status === 'received' ? 'مستلم' : 'قيد النقل'}</Badge></td>
              <td>{t.status === 'in_transit' && <button className="btn small" onClick={() => receive(t.id)}>استلام</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
