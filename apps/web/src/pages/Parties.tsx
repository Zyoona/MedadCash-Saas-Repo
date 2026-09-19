import { useEffect, useState } from 'react';
import { api, money } from '../api.js';
import { Field, Money, Tabs, useToast } from '../ui.js';
import { usePaySources } from '../banks.js';

interface Party { id: string; name: string; phone: string | null; balanceAgora: number; creditLimitAgora?: number; paymentTerms?: string | null; isCashDefault?: boolean }

export function Parties() {
  const [tab, setTab] = useState('customers');
  return (
    <div className="card">
      <h2>العملاء والموردون</h2>
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'customers', label: 'العملاء (فرعي)' }, { id: 'suppliers', label: 'الموردون (مركزي)' }]} />
      {tab === 'customers' ? <CustomersTab /> : <SuppliersTab />}
    </div>
  );
}

function CustomersTab() {
  const [rows, setRows] = useState<Party[]>([]);
  const [form, setForm] = useState({ name: '', phone: '', openingBalanceAgora: 0, creditLimitAgora: 0, paymentTerms: '' });
  const [collect, setCollect] = useState<{ id: string; name: string; amount: number; code: string } | null>(null);
  const { sources } = usePaySources(true);
  const [toast, showToast] = useToast();

  const load = () => api<Party[]>('/parties/customers').then(setRows).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    try {
      await api('/parties/customers', { method: 'POST', body: { ...form, phone: form.phone || undefined, paymentTerms: form.paymentTerms || undefined } });
      showToast('أُضيف العميل (مع قيد افتتاحي إن وُجد رصيد)');
      setForm({ name: '', phone: '', openingBalanceAgora: 0, creditLimitAgora: 0, paymentTerms: '' });
      load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const doCollect = async () => {
    if (!collect) return;
    try {
      await api(`/parties/customers/${collect.id}/collect`, { method: 'POST', body: { accountCode: collect.code, amountAgora: collect.amount } });
      const src = sources.find((s) => s.code === collect.code)?.label ?? collect.code;
      showToast(`تم التحصيل من ${collect.name} — ${src}`);
      setCollect(null); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <>
      <div className="row2 wrap">
        <input placeholder="اسم العميل" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="هاتف" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <input type="number" placeholder="افتتاحي (أغورات)" value={form.openingBalanceAgora} onChange={(e) => setForm({ ...form, openingBalanceAgora: Number(e.target.value) })} style={{ width: 140 }} />
        <input type="number" placeholder="حد الدين (أغورات)" value={form.creditLimitAgora} onChange={(e) => setForm({ ...form, creditLimitAgora: Number(e.target.value) })} style={{ width: 140 }} />
        <input placeholder="شروط الدفع" value={form.paymentTerms} onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })} />
        <button className="btn" onClick={create} disabled={!form.name}>+ إضافة</button>
      </div>
      <table className="grid">
        <thead><tr><th>الاسم</th><th>الهاتف</th><th>الرصيد</th><th>حد الدين</th><th>تحصيل</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>{c.name}{c.isCashDefault ? ' (نقدي)' : ''}</td>
              <td>{c.phone ?? '—'}</td>
              <td><Money agora={c.balanceAgora} /></td>
              <td>{c.creditLimitAgora ? money(c.creditLimitAgora) : '—'}</td>
              <td>
                {!c.isCashDefault && (
                  <button className="btn secondary small" onClick={() => setCollect({ id: c.id, name: c.name, amount: 0, code: sources[0]?.code ?? '1000' })}>تحصيل</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {collect && (
        <div className="modal-backdrop" onClick={() => setCollect(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>تحصيل من عميل — {collect.name}</h3><button className="btn secondary" onClick={() => setCollect(null)}>✕</button></div>
            <div className="modal-body">
              <Field label="المبلغ (أغورات)"><input type="number" value={collect.amount} onChange={(e) => setCollect({ ...collect, amount: Number(e.target.value) })} /></Field>
              <Field label="يُقبض في">
                <select value={collect.code} onChange={(e) => setCollect({ ...collect, code: e.target.value })}>
                  {sources.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
                </select>
              </Field>
              <button className="btn wide" onClick={doCollect} disabled={collect.amount <= 0}>تنفيذ التحصيل</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function SuppliersTab() {
  const [rows, setRows] = useState<Party[]>([]);
  const [form, setForm] = useState({ name: '', phone: '', openingBalanceAgora: 0 });
  const [pay, setPay] = useState<{ id: string; name: string; amount: number; code: string } | null>(null);
  const { sources } = usePaySources(true);
  const [toast, showToast] = useToast();

  const load = () => api<Party[]>('/parties/suppliers').then(setRows).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    try {
      await api('/parties/suppliers', { method: 'POST', body: { ...form, phone: form.phone || undefined } });
      showToast('أُضيف المورد');
      setForm({ name: '', phone: '', openingBalanceAgora: 0 });
      load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const doPay = async () => {
    if (!pay) return;
    try {
      await api(`/parties/suppliers/${pay.id}/pay`, { method: 'POST', body: { accountCode: pay.code, amountAgora: pay.amount } });
      const src = sources.find((s) => s.code === pay.code)?.label ?? pay.code;
      showToast(`تم الدفع لـ ${pay.name} — ${src}`);
      setPay(null); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <>
      <div className="row2 wrap">
        <input placeholder="اسم المورد" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="هاتف" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <input type="number" placeholder="افتتاحي (أغورات)" value={form.openingBalanceAgora} onChange={(e) => setForm({ ...form, openingBalanceAgora: Number(e.target.value) })} style={{ width: 140 }} />
        <button className="btn" onClick={create} disabled={!form.name}>+ إضافة</button>
      </div>
      <table className="grid">
        <thead><tr><th>الاسم</th><th>الهاتف</th><th>الرصيد المستحق</th><th>دفع</th></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.phone ?? '—'}</td>
              <td><Money agora={s.balanceAgora} /></td>
              <td><button className="btn secondary small" onClick={() => setPay({ id: s.id, name: s.name, amount: 0, code: sources[0]?.code ?? '1000' })}>دفع</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {pay && (
        <div className="modal-backdrop" onClick={() => setPay(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>دفع لمورد — {pay.name}</h3><button className="btn secondary" onClick={() => setPay(null)}>✕</button></div>
            <div className="modal-body">
              <Field label="المبلغ (أغورات)"><input type="number" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: Number(e.target.value) })} /></Field>
              <Field label="يُدفع من">
                <select value={pay.code} onChange={(e) => setPay({ ...pay, code: e.target.value })}>
                  {sources.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
                </select>
              </Field>
              <button className="btn wide" onClick={doPay} disabled={pay.amount <= 0}>تنفيذ الدفع</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
