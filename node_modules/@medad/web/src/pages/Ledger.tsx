import { useEffect, useState } from 'react';
import { api, auditEvent, money } from '../api.js';
import { Badge, CsvButton, Field, Modal, Tabs, useToast } from '../ui.js';
import { PageLoader } from '../Loader.js';
import { bankLabel, usePaySources, type BankAccount } from '../banks.js';

// القيود ودفتر الأستاذ (§Phase1): قراءة فقط + عكس بقيد جديد + حسابات + بنوك + شيكات + سنوات + تدقيق.

export function LedgerPage() {
  const [tab, setTab] = useState('trial');
  useEffect(() => { auditEvent('view', 'ledger'); }, []);
  return (
    <div>
      <Tabs active={tab} onChange={setTab} tabs={[
        { id: 'trial', label: 'ميزان المراجعة' },
        { id: 'entries', label: 'القيود' },
        { id: 'accounts', label: 'الحسابات' },
        { id: 'banks', label: 'الحسابات البنكية' },
        { id: 'checks', label: 'الشيكات' },
        { id: 'fiscal', label: 'السنوات المالية' },
        { id: 'audit', label: 'التدقيق' },
      ]} />
      {tab === 'trial' && <TrialTab />}
      {tab === 'entries' && <EntriesTab />}
      {tab === 'accounts' && <AccountsTab />}
      {tab === 'banks' && <BanksTab />}
      {tab === 'checks' && <ChecksTab />}
      {tab === 'fiscal' && <FiscalTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

function TrialTab() {
  const [data, setData] = useState<any>(null);
  const [toast, showToast] = useToast();
  useEffect(() => { api('/ledger/trial-balance?byAccount=1').then(setData).catch((e) => showToast((e as Error).message, 'bad')); }, []);
  if (!data) return <div className="card"><PageLoader /></div>;
  return (
    <div className="card full">
      {toast}
      <div className="row-between">
        <h2>ميزان المراجعة</h2>
        <Badge tone={data.balanced ? 'ok' : 'bad'}>{data.balanced ? 'متوازن' : 'غير متوازن'}</Badge>
      </div>
      <div className="table-scroll">
      <table className="grid">
        <thead><tr><th>الكود</th><th>الحساب</th><th>النوع</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead>
        <tbody>
          {data.rows.filter((r: any) => r.debitAgora || r.creditAgora).map((r: any) => (
            <tr key={r.id}>
              <td className="mono">{r.code}</td><td>{r.name}</td><td>{r.type}</td>
              <td>{money(r.debitAgora)}</td><td>{money(r.creditAgora)}</td>
              <td><strong>{money(r.balanceAgora)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <CsvButton filename="trial-balance.csv" rows={data.rows.map((r: any) => ({ code: r.code, name: r.name, debit: r.debitAgora / 100, credit: r.creditAgora / 100, balance: r.balanceAgora / 100 }))} />
    </div>
  );
}

function EntriesTab() {
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<any>(null);
  const [reverse, setReverse] = useState<{ id: string } | null>(null);
  const [reason, setReason] = useState('');
  const [fyId, setFyId] = useState('');
  const [toast, showToast] = useToast();

  const load = () => api<any>(`/ledger/entries?page=${page}&pageSize=20`).then(setData).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, [page]);
  useEffect(() => { api<any[]>('/fiscal-years').then((f) => { const open = f.find((x) => !x.isClosed); if (open) setFyId(open.id); }); }, []);

  const doReverse = async () => {
    if (!reverse) return;
    try {
      await api(`/ledger/entries/${reverse.id}/reverse`, { method: 'POST', body: { reason, fiscalYearId: fyId } });
      showToast('أُنشئ قيد عكسي جديد — القيد الأصلي لم يُمس');
      setReverse(null); setReason(''); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div className="card full">
      {toast}
      <h2>القيود — قراءة فقط، التصحيح بقيد عكسي فقط</h2>
      <div className="table-scroll">
      <table className="grid">
        <thead><tr><th>التاريخ</th><th>النوع</th><th>المرجع</th><th>مذكرة</th><th>عكسي؟</th><th></th></tr></thead>
        <tbody>
          {(data?.rows ?? []).map((e: any) => (
            <tr key={e.id}>
              <td>{new Date(e.date).toLocaleDateString('ar')}</td>
              <td>{e.sourceType}</td>
              <td className="mono">{e.sourceId.slice(0, 8)}</td>
              <td>{e.memo ?? '—'}</td>
              <td>{e.reversesEntryId ? <Badge tone="warn">عكس</Badge> : ''}</td>
              <td className="actions">
                <button className="btn secondary small" onClick={() => api(`/ledger/entries/${e.id}`).then(setDetail)}>تفاصيل</button>
                {!e.reversesEntryId && <button className="btn secondary small" onClick={() => setReverse({ id: e.id })}>عكس</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <div className="row2">
        <button className="btn secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>السابق</button>
        <span>صفحة {page} / {Math.max(1, Math.ceil((data?.total ?? 0) / 20))}</span>
        <button className="btn secondary" disabled={page >= Math.ceil((data?.total ?? 0) / 20)} onClick={() => setPage(page + 1)}>التالي</button>
      </div>
      {detail && (
        <Modal title={`قيد ${detail.sourceType}`} onClose={() => setDetail(null)}>
          <table className="grid">
            <thead><tr><th>الحساب</th><th>مدين</th><th>دائن</th></tr></thead>
            <tbody>
              {detail.lines.map((l: any) => (
                <tr key={l.id}><td>{l.account.code} — {l.account.name}</td><td>{money(Math.round(Number(l.debit) * 100))}</td><td>{money(Math.round(Number(l.credit) * 100))}</td></tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
      {reverse && (
        <Modal title="عكس القيد (قيد جديد)" onClose={() => setReverse(null)}>
          <Field label="السبب (إلزامي)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <button className="btn wide" onClick={doReverse} disabled={!reason}>تنفيذ العكس</button>
        </Modal>
      )}
    </div>
  );
}

function AccountsTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [form, setForm] = useState({ code: '', name: '', type: 'asset' });
  const [opening, setOpening] = useState<{ code: string; amount: number } | null>(null);
  const [transfer, setTransfer] = useState({ fromCode: '1000', toCode: '1100', amount: 0 });
  const [toast, showToast] = useToast();

  const load = () => api<any[]>('/accounts').then(setRows).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    try {
      await api('/accounts', { method: 'POST', body: form });
      showToast('أُنشئ الحساب'); setForm({ code: '', name: '', type: 'asset' }); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };
  const doOpening = async () => {
    if (!opening) return;
    try {
      await api('/accounts/opening', { method: 'POST', body: { accountCode: opening.code, amountAgora: opening.amount } });
      showToast('قيد افتتاحي: مقابل 3900'); setOpening(null); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };
  const doTransfer = async () => {
    try {
      await api('/accounts/transfer', { method: 'POST', body: { fromCode: transfer.fromCode, toCode: transfer.toCode, amountAgora: transfer.amount } });
      showToast('تم التحويل بين الحسابين'); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };
  const close = async (id: string) => {
    try { await api(`/accounts/${id}/close`, { method: 'POST', body: {} }); showToast('أُغلق — لن يقبل قيوداً'); load(); }
    catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div className="card full">
      {toast}
      <h2>دليل الحسابات</h2>
      <div className="row2 wrap">
        <input placeholder="كود" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} style={{ width: 90 }} />
        <input placeholder="اسم الحساب" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
          {['asset', 'liability', 'equity', 'revenue', 'expense'].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button className="btn" onClick={create} disabled={!form.code || !form.name}>+ حساب مخصص</button>
      </div>
      <div className="table-scroll">
      <table className="grid">
        <thead><tr><th>كود</th><th>الاسم</th><th>مدين</th><th>دائن</th><th>الرصيد</th><th>إجراءات</th></tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="mono">{a.code}</td><td>{a.name}{a.isClosed ? ' 🔒' : ''}</td>
              <td>{money(a.debitAgora)}</td><td>{money(a.creditAgora)}</td><td><strong>{money(a.balanceAgora)}</strong></td>
              <td className="actions">
                <button className="btn secondary small" onClick={() => setOpening({ code: a.code, amount: 0 })}>افتتاحي</button>
                {!a.isClosed && <button className="btn secondary small" onClick={() => close(a.id)}>إغلاق</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <h4>تحويل بين الحسابات</h4>
      <div className="row2 wrap">
        <select value={transfer.fromCode} onChange={(e) => setTransfer({ ...transfer, fromCode: e.target.value })}>
          {rows.map((a) => <option key={a.id} value={a.code}>{a.code} {a.name}</option>)}
        </select>
        <span>→</span>
        <select value={transfer.toCode} onChange={(e) => setTransfer({ ...transfer, toCode: e.target.value })}>
          {rows.map((a) => <option key={a.id} value={a.code}>{a.code} {a.name}</option>)}
        </select>
        <input type="number" placeholder="مبلغ (أغورات)" value={transfer.amount} onChange={(e) => setTransfer({ ...transfer, amount: Number(e.target.value) })} />
        <button className="btn" onClick={doTransfer} disabled={transfer.amount <= 0}>تحويل</button>
      </div>
      {opening && (
        <Modal title={`رصيد افتتاحي: ${opening.code}`} onClose={() => setOpening(null)}>
          <Field label="المبلغ (أغورات، سالب للطرف المعاكس)"><input type="number" value={opening.amount} onChange={(e) => setOpening({ ...opening, amount: Number(e.target.value) })} /></Field>
          <button className="btn wide" onClick={doOpening} disabled={!opening.amount}>تنفيذ</button>
        </Modal>
      )}
    </div>
  );
}

function BanksTab() {
  const [rows, setRows] = useState<BankAccount[]>([]);
  const [form, setForm] = useState({ bankName: '', accountLabel: '', accountNumber: '', iban: '', openingBalanceAgora: 0 });
  const [editing, setEditing] = useState<BankAccount | null>(null);
  const [toast, showToast] = useToast();

  const load = () => api<BankAccount[]>('/accounts/banks').then((r) => setRows(r)).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    try {
      await api('/accounts/banks', {
        method: 'POST',
        body: {
          bankName: form.bankName,
          accountLabel: form.accountLabel || undefined,
          accountNumber: form.accountNumber || undefined,
          iban: form.iban || undefined,
          openingBalanceAgora: form.openingBalanceAgora > 0 ? form.openingBalanceAgora : undefined,
        },
      });
      showToast('أُنشئ الحساب البنكي (مع قيد افتتاحي إن وُجد رصيد) — ظاهر الآن ضمن خيارات الدفع');
      setForm({ bankName: '', accountLabel: '', accountNumber: '', iban: '', openingBalanceAgora: 0 });
      load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await api(`/accounts/banks/${editing.id}`, {
        method: 'PATCH',
        body: {
          bankName: editing.bankName,
          accountLabel: editing.accountLabel,
          accountNumber: editing.accountNumber,
          iban: editing.iban,
          notes: editing.notes,
        },
      });
      showToast('حُفظت التعديلات'); setEditing(null); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const toggleActive = async (b: BankAccount) => {
    try {
      await api(`/accounts/banks/${b.id}`, { method: 'PATCH', body: { isActive: !b.isActive } });
      showToast(b.isActive ? 'عُطّل — لن يظهر في خيارات الدفع' : 'فُعّل — ظاهر في خيارات الدفع');
      load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const remove = async (b: BankAccount) => {
    if (!confirm(`حذف "${bankLabel(b)}"؟ الحذف ناعم ولا يمكن مع وجود رصيد.`)) return;
    try {
      await api(`/accounts/banks/${b.id}`, { method: 'DELETE' });
      showToast('حُذف الحساب البنكي'); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div className="card full">
      {toast}
      <h2>الحسابات البنكية — تُدار هنا وتظهر تلقائياً ضمن كل خيارات الدفع والتحصيل</h2>
      <div className="row2 wrap">
        <input placeholder="اسم البنك *" value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} />
        <input placeholder="وصف الحساب (جاري/ودائع...)" value={form.accountLabel} onChange={(e) => setForm({ ...form, accountLabel: e.target.value })} />
        <input placeholder="رقم الحساب" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
        <input placeholder="IBAN" value={form.iban} onChange={(e) => setForm({ ...form, iban: e.target.value })} />
        <input type="number" placeholder="رصيد افتتاحي (أغورات)" value={form.openingBalanceAgora} onChange={(e) => setForm({ ...form, openingBalanceAgora: Number(e.target.value) })} style={{ width: 170 }} />
        <button className="btn" onClick={create} disabled={!form.bankName.trim()}>+ حساب بنكي</button>
      </div>
      <div className="table-scroll">
      <table className="grid">
        <thead><tr><th>البنك</th><th>كود GL</th><th>رقم الحساب / IBAN</th><th>الرصيد</th><th>الحالة</th><th>إجراءات</th></tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td>{bankLabel(b)}</td>
              <td className="mono">{b.glAccountCode}</td>
              <td className="mono">{b.accountNumber ?? '—'}<br />{b.iban ?? ''}</td>
              <td><strong>{money(b.balanceAgora ?? 0)}</strong></td>
              <td><Badge tone={b.isActive ? 'ok' : 'bad'}>{b.isActive ? 'نشط' : 'معطل'}</Badge></td>
              <td className="actions">
                <button className="btn secondary small" onClick={() => setEditing({ ...b })}>تعديل</button>
                <button className="btn secondary small" onClick={() => toggleActive(b)}>{b.isActive ? 'تعطيل' : 'تفعيل'}</button>
                <button className="btn secondary small" onClick={() => remove(b)}>حذف</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6}>لا حسابات بنكية بعد — أضف أول حساب وسيظهر فوراً في الكاشير والتحصيل والشيكات</td></tr>}
        </tbody>
      </table>
      </div>
      {editing && (
        <Modal title={`تعديل: ${bankLabel(editing)}`} onClose={() => setEditing(null)}>
          <Field label="اسم البنك"><input value={editing.bankName} onChange={(e) => setEditing({ ...editing, bankName: e.target.value })} /></Field>
          <Field label="وصف الحساب"><input value={editing.accountLabel ?? ''} onChange={(e) => setEditing({ ...editing, accountLabel: e.target.value })} /></Field>
          <Field label="رقم الحساب"><input value={editing.accountNumber ?? ''} onChange={(e) => setEditing({ ...editing, accountNumber: e.target.value })} /></Field>
          <Field label="IBAN"><input value={editing.iban ?? ''} onChange={(e) => setEditing({ ...editing, iban: e.target.value })} /></Field>
          <Field label="ملاحظات"><input value={editing.notes ?? ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Field>
          <p className="muted">كود GL ({editing.glAccountCode}) ثابت بعد الإنشاء حفاظاً على سلامة القيود.</p>
          <button className="btn wide" onClick={saveEdit} disabled={!editing.bankName.trim()}>حفظ</button>
        </Modal>
      )}
    </div>
  );
}

function ChecksTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [form, setForm] = useState({ checkNumber: '', direction: 'in', amountAgora: 0, dueDate: '', partyName: '' });
  const [clearing, setClearing] = useState<{ id: string; number: string; code: string } | null>(null);
  const { sources } = usePaySources(true);
  const [toast, showToast] = useToast();

  const load = () => {
    api<any[]>('/accounts/checks/list').then(setRows).catch((e) => showToast((e as Error).message, 'bad'));
    api<any[]>('/accounts/checks/alerts').then(setAlerts).catch(() => undefined);
  };
  useEffect(() => { void load(); }, []);

  const create = async () => {
    try {
      await api('/accounts/checks', { method: 'POST', body: { ...form, dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : new Date().toISOString() } });
      showToast('سُجل الشيك بقيده'); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };
  const bounce = async (id: string) => {
    try {
      await api(`/accounts/checks/${id}/bounce`, { method: 'POST', body: {} });
      showToast('ارتُجع الشيك'); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };
  const doClear = async () => {
    if (!clearing) return;
    try {
      await api(`/accounts/checks/${clearing.id}/clear`, { method: 'POST', body: { accountCode: clearing.code } });
      showToast('صُرف الشيك — حُوّل لحساب الدفع المحدد'); setClearing(null); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div className="card full">
      {toast}
      <h2>الشيكات + تنبيه الاستحقاق</h2>
      {alerts.length > 0 && <div className="alert">⚠ {alerts.length} شيك مستحق خلال أسبوع: {alerts.map((c) => c.checkNumber).join('، ')}</div>}
      <div className="row2 wrap">
        <input placeholder="رقم الشيك" value={form.checkNumber} onChange={(e) => setForm({ ...form, checkNumber: e.target.value })} />
        <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
          <option value="in">وارد (عميل)</option><option value="out">صادر (مورد)</option>
        </select>
        <input type="number" placeholder="مبلغ (أغورات)" value={form.amountAgora} onChange={(e) => setForm({ ...form, amountAgora: Number(e.target.value) })} />
        <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
        <input placeholder="الطرف" value={form.partyName} onChange={(e) => setForm({ ...form, partyName: e.target.value })} />
        <button className="btn" onClick={create} disabled={!form.checkNumber || !form.amountAgora}>+ تسجيل</button>
      </div>
      <div className="table-scroll">
      <table className="grid">
        <thead><tr><th>رقم</th><th>اتجاه</th><th>مبلغ</th><th>الاستحقاق</th><th>الحالة</th><th>إجراءات</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td className="mono">{c.checkNumber}</td>
              <td>{c.direction === 'in' ? 'وارد' : 'صادر'}</td>
              <td>{money(Math.round(Number(c.amount) * 100))}</td>
              <td>{new Date(c.dueDate).toLocaleDateString('ar')}</td>
              <td><Badge tone={c.status === 'pending' ? 'warn' : c.status === 'cleared' ? 'ok' : 'bad'}>{c.status}</Badge></td>
              <td className="actions">
                {c.status === 'pending' && <>
                  <button className="btn small" onClick={() => setClearing({ id: c.id, number: c.checkNumber, code: sources[0]?.code ?? '1000' })}>صرف</button>
                  <button className="btn secondary small" onClick={() => bounce(c.id)}>ارتجاع</button>
                 </>}
               </td>
             </tr>
           ))}
         </tbody>
       </table>
       </div>
       {clearing && (
        <Modal title={`صرف شيك ${clearing.number}`} onClose={() => setClearing(null)}>
          <Field label="يُودع في">
            <select value={clearing.code} onChange={(e) => setClearing({ ...clearing, code: e.target.value })}>
              {sources.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
          </Field>
          <button className="btn wide" onClick={doClear}>تنفيذ الصرف</button>
        </Modal>
      )}
    </div>
  );
}

function FiscalTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [form, setForm] = useState({ name: '', startDate: '', endDate: '' });
  const [toast, showToast] = useToast();

  const load = () => api<any[]>('/fiscal-years').then(setRows).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    try {
      await api('/fiscal-years', { method: 'POST', body: form });
      showToast('أُنشئت السنة'); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };
  const close = async (id: string) => {
    if (!confirm('إقفال السنة ينشئ قيود الإقفال ويمنع أي قيد جديد عليها. متابعة؟')) return;
    try {
      const r = await api<any>(`/fiscal-years/${id}/close`, { method: 'POST', body: {} });
      showToast(`أُقفلت — صافي النتيجة: ${money(r.profitAgora)}`); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div className="card full">
      {toast}
      <h2>السنوات المالية</h2>
      <div className="row2 wrap">
        <input placeholder="الاسم (2027)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: 110 }} />
        <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
        <input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
        <button className="btn" onClick={create} disabled={!form.name}>+ سنة</button>
      </div>
      <div className="table-scroll">
      <table className="grid">
        <thead><tr><th>السنة</th><th>من</th><th>إلى</th><th>الحالة</th><th></th></tr></thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.id}>
              <td>{f.name}</td>
              <td>{new Date(f.startDate).toLocaleDateString('ar')}</td>
              <td>{new Date(f.endDate).toLocaleDateString('ar')}</td>
              <td><Badge tone={f.isClosed ? 'bad' : 'ok'}>{f.isClosed ? 'مغلقة' : 'مفتوحة'}</Badge></td>
              <td>{!f.isClosed && <button className="btn secondary small" onClick={() => close(f.id)}>إقفال</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function AuditTab() {
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [toast, showToast] = useToast();

  const load = () => api<any>(`/audit?page=${page}&pageSize=25`).then(setData).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, [page]);

  return (
    <div className="card full">
      {toast}
      <div className="row-between">
        <h2>سجل التدقيق (Audit Log)</h2>
        <CsvButton filename="audit.csv" rows={(data?.rows ?? []).map((r: any) => ({ date: r.createdAt, actor: r.actor?.name, action: r.action, entity: r.entity, entityId: r.entityId }))} />
      </div>
      <div className="table-scroll">
      <table className="grid">
        <thead><tr><th>الوقت</th><th>المستخدم</th><th>الإجراء</th><th>الكيان</th><th>المعرف</th></tr></thead>
        <tbody>
          {(data?.rows ?? []).map((r: any) => (
            <tr key={r.id}>
              <td>{new Date(r.createdAt).toLocaleString('ar')}</td>
              <td>{r.actor?.name ?? 'النظام'}</td>
              <td><Badge tone={r.action.includes('fail') || r.action.includes('bounced') ? 'bad' : 'ok'}>{r.action}</Badge></td>
              <td>{r.entity}</td>
              <td className="mono">{r.entityId?.slice(0, 8)}</td>
             </tr>
           ))}
         </tbody>
       </table>
       </div>
       <div className="row2">
        <button className="btn secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>السابق</button>
        <span>صفحة {page}</span>
        <button className="btn secondary" onClick={() => setPage(page + 1)}>التالي</button>
      </div>
    </div>
  );
}
