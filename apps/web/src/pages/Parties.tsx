import { useEffect, useState } from 'react';
import { api, money } from '../api.js';
import { Badge, Field, Money, Modal, SplitAgora, Tabs, useToast, CsvButton } from '../ui.js';
import { usePaySources } from '../banks.js';

interface Party { id: string; name: string; phone: string | null; balanceAgora: number; creditLimitAgora?: number; paymentTerms?: string | null; isCashDefault?: boolean }

interface CollectResult { entryId: string; balanceBeforeAgora: number; balanceAfterAgora: number; overpaidAgora: number; creditBalanceAgora: number; warning: string | null }

interface StatementRow { entryId: string; date: string; sourceType: string; sourceId: string; memo: string | null; debitAgora: number; creditAgora: number; balanceAgora: number }
interface StatementData { customer: { id: string; name: string }; balanceAgora: number; rows: StatementRow[] }

interface AgingRow { customerId: string; name: string; debtAgora: number; b0_30Agora: number; b31_60Agora: number; b61_90Agora: number; b90plusAgora: number; oldestInvoiceDays: number | null }
interface AgingData { rows: AgingRow[]; totalDebtAgora: number }

export function Parties() {
  const [tab, setTab] = useState('customers');
  return (
    <div className="card">
      <h2>العملاء والموردون</h2>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'customers', label: 'العملاء (فرعي)' },
          { id: 'suppliers', label: 'الموردون (مركزي)' },
          { id: 'aging', label: 'أعمار الديون' },
        ]}
      />
      {tab === 'customers' ? <CustomersTab /> : tab === 'suppliers' ? <SuppliersTab /> : <AgingTab />}
    </div>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

const SOURCE_TYPE_AR: Record<string, string> = {
  sale: 'فاتورة مبيعات',
  sale_cogs: 'تكلفة مبيعات',
  collection: 'تحصيل',
  sale_return: 'مرتجع مبيعات',
  opening_balance: 'رصيد افتتاحي',
  reversal: 'عكس قيد',
};
const sourceTypeAr = (s: string): string => SOURCE_TYPE_AR[s] ?? s;

/** رصيد الطرف: موجب = عليه دين، سالب = له رصيد مستحق */
function PartyBalance({ balanceAgora }: { balanceAgora: number }) {
  if (balanceAgora > 0) return <Money agora={balanceAgora} />;
  if (balanceAgora < 0) return <Badge tone="ok">له رصيد مستحق {money(-balanceAgora)}</Badge>;
  return <span className="muted">—</span>;
}

function CustomersTab() {
  const [rows, setRows] = useState<Party[]>([]);
  const [form, setForm] = useState({ name: '', phone: '', openingBalanceAgora: 0, creditLimitAgora: 0, paymentTerms: '' });
  const [collect, setCollect] = useState<{ id: string; name: string; amount: number; code: string; date: string; memo: string; debt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stmt, setStmt] = useState<StatementData | null>(null);
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
    if (!collect || busy) return;
    if (!Number.isInteger(collect.amount) || collect.amount <= 0) {
      showToast('أدخل مبلغاً صحيحاً أكبر من صفر', 'bad');
      return;
    }
    setBusy(true);
    try {
      const res = await api<CollectResult>(`/parties/customers/${collect.id}/collect`, {
        method: 'POST',
        body: { accountCode: collect.code, amountAgora: collect.amount, date: collect.date, memo: collect.memo || undefined },
      });
      const src = sources.find((s) => s.code === collect.code)?.label ?? collect.code;
      let msg = `تم التحصيل من ${collect.name} — ${src}`;
      if (res.overpaidAgora > 0) {
        msg += ` ⚠️ دفع زائد ${money(res.overpaidAgora)} — أصبح للعميل رصيداً مستحقاً له. لا بأس بذلك.`;
      }
      showToast(msg);
      setCollect(null);
      load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
    finally { setBusy(false); }
  };

  const openStatement = async (id: string) => {
    try { setStmt(await api<StatementData>(`/parties/customers/${id}/statement`)); }
    catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const overpayPreview = collect && collect.amount > 0 && collect.amount > Math.max(0, collect.debt)
    ? {
        surplus: collect.amount - Math.max(0, collect.debt),
        box: (
          <div className="badge warn" style={{ display: 'block', marginBottom: 10 }}>
            ⚠️ المبلغ أكبر من الدين الحالي ({money(Math.max(0, collect.debt))}) — الفائض ({money(collect.amount - Math.max(0, collect.debt))}) سيُسجَّل رصيداً مستحقاً للعميل. لا بأس بذلك.
          </div>
        ),
      }
    : null;

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
        <thead><tr><th>الاسم</th><th>الهاتف</th><th>الرصيد</th><th>حد الدين</th><th>إجراءات</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>{c.name}{c.isCashDefault ? ' (نقدي)' : ''}</td>
              <td>{c.phone ?? '—'}</td>
              <td><PartyBalance balanceAgora={c.balanceAgora} /></td>
              <td>{c.creditLimitAgora ? money(c.creditLimitAgora) : '—'}</td>
              <td>
                {!c.isCashDefault && (
                  <button className="btn secondary small" onClick={() => setCollect({ id: c.id, name: c.name, amount: 0, code: sources[0]?.code ?? '1000', date: today(), memo: '', debt: c.balanceAgora })}>تحصيل</button>
                )}{' '}
                <button className="btn secondary small" onClick={() => void openStatement(c.id)}>كشف حساب</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {collect && (
        <Modal title={`تحصيل من عميل — ${collect.name}`} onClose={() => setCollect(null)}>
          <p>
            الدين الحالي: {collect.debt > 0
              ? <strong><Money agora={collect.debt} /></strong>
              : collect.debt < 0
                ? <Badge tone="ok">له رصيد مستحق {money(-collect.debt)}</Badge>
                : <span className="muted">لا دين عليه</span>}
          </p>
          {overpayPreview?.box}
          <Field label="المبلغ" hint="أدخل المبلغ بالشيكل والأغورات. الدفع الزائد مسموح — يُسجَّل الفائض رصيداً مستحقاً للعميل.">
            <SplitAgora agora={collect.amount} onAgora={(agora) => setCollect({ ...collect, amount: agora })} label="المبلغ" />
          </Field>
          <Field label="يُقبض في">
            <select value={collect.code} onChange={(e) => setCollect({ ...collect, code: e.target.value })}>
              {sources.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="التاريخ"><input type="date" value={collect.date} onChange={(e) => setCollect({ ...collect, date: e.target.value })} /></Field>
          <Field label="ملاحظة (اختياري)"><input placeholder="ملاحظة" value={collect.memo} onChange={(e) => setCollect({ ...collect, memo: e.target.value })} /></Field>
          <button className="btn wide" onClick={doCollect} disabled={busy || collect.amount <= 0}>{busy ? 'جارٍ التنفيذ…' : 'تنفيذ التحصيل'}</button>
        </Modal>
      )}
      {stmt && (
        <Modal title={`كشف حساب — ${stmt.customer.name}`} onClose={() => setStmt(null)} wide>
          <p>
            الرصيد الحالي:{' '}
            {stmt.balanceAgora > 0
              ? <strong>عليه دين <Money agora={stmt.balanceAgora} /></strong>
              : stmt.balanceAgora < 0
                ? <Badge tone="ok">له رصيد مستحق {money(-stmt.balanceAgora)}</Badge>
                : <span className="muted">صفر</span>}
          </p>
          {stmt.rows.length === 0
            ? <p className="muted">لا حركات على ذمة هذا العميل</p>
            : (
              <table className="grid">
                <thead><tr><th>التاريخ</th><th>البيان</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead>
                <tbody>
                  {stmt.rows.map((r) => (
                    <tr key={r.entryId}>
                      <td>{new Date(r.date).toLocaleDateString('ar')}</td>
                      <td>{sourceTypeAr(r.sourceType)}{r.memo ? ` — ${r.memo}` : ''}</td>
                      <td>{r.debitAgora > 0 ? <Money agora={r.debitAgora} /> : '—'}</td>
                      <td>{r.creditAgora > 0 ? <Money agora={r.creditAgora} /> : '—'}</td>
                      <td><PartyBalance balanceAgora={r.balanceAgora} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          <CsvButton
            filename={`statement-${stmt.customer.name}.csv`}
            rows={stmt.rows.map((r) => ({ التاريخ: new Date(r.date).toLocaleDateString('ar'), البيان: `${sourceTypeAr(r.sourceType)}${r.memo ? ' — ' + r.memo : ''}`, مدين: r.debitAgora, دائن: r.creditAgora, الرصيد: r.balanceAgora }))}
          />
        </Modal>
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
        <Modal title={`دفع لمورد — ${pay.name}`} onClose={() => setPay(null)}>
          <Field label="المبلغ (أغورات)"><input type="number" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: Number(e.target.value) })} /></Field>
          <Field label="يُدفع من">
            <select value={pay.code} onChange={(e) => setPay({ ...pay, code: e.target.value })}>
              {sources.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
          </Field>
          <button className="btn wide" onClick={doPay} disabled={pay.amount <= 0}>تنفيذ الدفع</button>
        </Modal>
      )}
    </>
  );
}

function AgingTab() {
  const [data, setData] = useState<AgingData | null>(null);
  const [toast, showToast] = useToast();

  const load = () => api<AgingData>('/parties/aging').then(setData).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  return (
    <>
      <p className="muted">توزيع ديون العملاء على فئات عمر حسب أقدم فاتورة مرحّة (الأقدم أولاً — FIFO). الدين الباقي بلا فواتير (رصيد افتتاحي) يظهر في الفئة الأقدم.</p>
      {data && data.rows.length > 0 && (
        <CsvButton
          filename="aging-debts.csv"
          rows={data.rows.map((r) => ({
            العميل: r.name,
            'إجمالي الدين': r.debtAgora,
            '0-30 يوم': r.b0_30Agora,
            '31-60 يوم': r.b31_60Agora,
            '61-90 يوم': r.b61_90Agora,
            'أكثر من 90 يوم': r.b90plusAgora,
            'أقدم فاتورة (يوم)': r.oldestInvoiceDays ?? '—',
          }))}
        />
      )}
      <table className="grid">
        <thead><tr><th>العميل</th><th>إجمالي الدين</th><th>0–30 يوم</th><th>31–60 يوم</th><th>61–90 يوم</th><th>أكثر من 90</th><th>أقدم فاتورة</th></tr></thead>
        <tbody>
          {!data && <tr><td colSpan={7}>جارٍ التحميل…</td></tr>}
          {data && data.rows.length === 0 && <tr><td colSpan={6}>لا ديون على أي عميل</td></tr>}
          {data?.rows.map((r) => (
            <tr key={r.customerId}>
              <td>{r.name}</td>
              <td><Money agora={r.debtAgora} /></td>
              <td>{r.b0_30Agora > 0 ? <Money agora={r.b0_30Agora} /> : '—'}</td>
              <td>{r.b31_60Agora > 0 ? <Money agora={r.b31_60Agora} /> : '—'}</td>
              <td>{r.b61_90Agora > 0 ? <Money agora={r.b61_90Agora} /> : '—'}</td>
              <td>{r.b90plusAgora > 0 ? <Badge tone="bad"><Money agora={r.b90plusAgora} /></Badge> : '—'}</td>
              <td>{r.oldestInvoiceDays === null ? '—' : `${r.oldestInvoiceDays} يوم`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && data.rows.length > 0 && (
        <p><strong>إجمالي الديون:</strong> <Money agora={data.totalDebtAgora} /></p>
      )}
    </>
  );
}
