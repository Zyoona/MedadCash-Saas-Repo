import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Field, useToast } from '../ui.js';

interface Task { id: string; serviceProduct: string; status: string; deadline: string | null; customer: { name: string } | null }

export function Tasks() {
  const [rows, setRows] = useState<Task[]>([]);
  const [form, setForm] = useState({ serviceProduct: '', deadline: '' });
  const [billing, setBilling] = useState<Task | null>(null);
  const [price, setPrice] = useState(0);
  const [toast, showToast] = useToast();

  const load = () => api<Task[]>('/ops/tasks').then(setRows).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    try {
      await api('/ops/tasks', { method: 'POST', body: { ...form, deadline: form.deadline || null } });
      showToast('أُنشئت المهمة'); setForm({ serviceProduct: '', deadline: '' }); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const setStatus = async (id: string, status: string) => {
    try { await api(`/ops/tasks/${id}/status`, { method: 'POST', body: { status } }); load(); }
    catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const bill = async () => {
    if (!billing) return;
    try {
      const res = await api<any>(`/ops/tasks/${billing.id}/bill`, { method: 'POST', body: { priceAgora: price, payments: [{ method: 'cash', accountCode: '1000', amountAgora: price }] } });
      showToast(`فُوترت كخدمة — فاتورة ${res.invoiceId.slice(0, 8)}`);
      setBilling(null); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const STATUS_AR: Record<string, string> = { open: 'مفتوحة', in_progress: 'جارية', ready: 'جاهزة للتسليم', delivered: 'سُلمت', cancelled: 'ملغاة' };

  return (
    <div className="card">
      {toast}
      <h2>المهام (خدمات: تجليد، طباعة...) — تُفوتر جاهزة للتسليم</h2>
      <div className="row2 wrap">
        <input placeholder="وصف الخدمة" value={form.serviceProduct} onChange={(e) => setForm({ ...form, serviceProduct: e.target.value })} />
        <input type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
        <button className="btn" onClick={create} disabled={!form.serviceProduct}>+ مهمة</button>
      </div>
      <table className="grid">
        <thead><tr><th>الخدمة</th><th>الزبون</th><th>الموعد</th><th>الحالة</th><th>إجراءات</th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>{t.serviceProduct}</td>
              <td>{t.customer?.name ?? '—'}</td>
              <td>{t.deadline ? new Date(t.deadline).toLocaleDateString('ar') : '—'}</td>
              <td><Badge tone={t.status === 'ready' ? 'warn' : t.status === 'delivered' ? 'ok' : 'bad'}>{STATUS_AR[t.status] ?? t.status}</Badge></td>
              <td className="actions">
                {t.status === 'open' && <button className="btn secondary small" onClick={() => setStatus(t.id, 'in_progress')}>بدء</button>}
                {t.status === 'in_progress' && <button className="btn secondary small" onClick={() => setStatus(t.id, 'ready')}>جهزت</button>}
                {t.status === 'ready' && <button className="btn small" onClick={() => { setBilling(t); setPrice(0); }}>فوترة كخدمة</button>}
                {t.status !== 'delivered' && t.status !== 'cancelled' && <button className="btn secondary small" onClick={() => setStatus(t.id, 'cancelled')}>إلغاء</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {billing && (
        <div className="modal-backdrop" onClick={() => setBilling(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>فوترة الخدمة: {billing.serviceProduct}</h3><button className="btn secondary" onClick={() => setBilling(null)}>✕</button></div>
            <div className="modal-body">
              <Field label="السعر (أغورات)"><input type="number" value={price} onChange={(e) => setPrice(Number(e.target.value))} /></Field>
              <button className="btn wide" onClick={bill} disabled={price <= 0}>فاتورة نقدية + تسليم</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
