import { useEffect, useState } from 'react';
import { api, downloadApi, uploadApi } from '../api.js';
import { Badge, Field, Modal, useToast } from '../ui.js';
import { useAuth } from '../auth.js';

export function Settings() {
  const [tab, setTab] = useState('general');
  const { can } = useAuth();
  const tabs: [string, string][] = [
    ['general', 'عامة'],
    ['users', 'المستخدمون والصلاحيات'],
    ['branches', 'الفروع'],
  ];
  if (can('backup.view') || can('system.wipe')) tabs.push(['maintenance', 'النسخ والصيانة']);
  return (
    <div className="card">
      <h2>الإعدادات</h2>
      <div className="tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'general' && <GeneralTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'branches' && <BranchesTab />}
      {tab === 'maintenance' && <MaintenanceTab />}
    </div>
  );
}

function GeneralTab() {
  const [s, setS] = useState<Record<string, any>>({});
  const [driveUrl, setDriveUrl] = useState('');
  const [driveToken, setDriveToken] = useState('');
  const [driveOAuth, setDriveOAuth] = useState({ clientId: '', clientSecret: '', refreshToken: '', folderId: '' });
  const [toast, showToast] = useToast();

  useEffect(() => { api<Record<string, any>>('/settings').then(setS).catch((e) => showToast((e as Error).message, 'bad')); }, []);

  const save = async (key: string, value: unknown) => {
    try {
      await api(`/settings/${key}`, { method: 'PUT', body: { value } });
      showToast(`حُفظ ${key}`);
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div>
      {toast}
      <div className="row2 wrap">
        <Field label="الضريبة الافتراضية (نقطة أساس: 0% = 0)">
          <input type="number" defaultValue={s.tax_rate?.rateBps ?? 0} onBlur={(e) => save('tax_rate', { rateBps: Number(e.target.value) })} />
        </Field>
        <Field label="بداية السنة (شهر)">
          <input type="number" min={1} max={12} defaultValue={s.fiscal_year_start?.month ?? 1} onBlur={(e) => save('fiscal_year_start', { month: Number(e.target.value), day: 1 })} />
        </Field>
        <Field label="حد التنبيه العام (النواقص)">
          <input type="number" defaultValue={s.low_stock_default?.qty ?? 5} onBlur={(e) => save('low_stock_default', { qty: Number(e.target.value) })} />
        </Field>
        <Field label="عدد النسخ المحفوظة">
          <input type="number" defaultValue={s.backup_keep?.n ?? 7} onBlur={(e) => save('backup_keep', { n: Number(e.target.value) })} />
        </Field>
        <Field label="نسخ تلقائي يومي">
          <select defaultValue={String(s.backup_auto?.enabled ?? true)} onChange={(e) => save('backup_auto', { enabled: e.target.value === 'true' })}>
            <option value="true">مفعّل</option><option value="false">معطل</option>
          </select>
        </Field>
      </div>
      <h4>Google Drive (يُخزن مشفراً AES-256-GCM)</h4>
      <div className="row2 wrap">
        <input placeholder="Client ID" value={driveOAuth.clientId} onChange={(e) => setDriveOAuth({ ...driveOAuth, clientId: e.target.value })} />
        <input placeholder="Client Secret" type="password" value={driveOAuth.clientSecret} onChange={(e) => setDriveOAuth({ ...driveOAuth, clientSecret: e.target.value })} />
        <input placeholder="Refresh Token" type="password" value={driveOAuth.refreshToken} onChange={(e) => setDriveOAuth({ ...driveOAuth, refreshToken: e.target.value })} />
        <input placeholder="معرّف المجلد (اختياري)" value={driveOAuth.folderId} onChange={(e) => setDriveOAuth({ ...driveOAuth, folderId: e.target.value })} />
      </div>
      <div className="row2 wrap">
        <input placeholder="وضع بديل — uploadUrl" value={driveUrl} onChange={(e) => setDriveUrl(e.target.value)} />
        <input placeholder="وضع بديل — token" type="password" value={driveToken} onChange={(e) => setDriveToken(e.target.value)} />
        <button
          className="btn"
          onClick={() => {
            const native = !!(driveOAuth.clientId && driveOAuth.clientSecret && driveOAuth.refreshToken);
            const generic = !!(driveUrl && driveToken);
            save('drive_config', {
              configured: native || generic,
              clientId: driveOAuth.clientId,
              clientSecret: driveOAuth.clientSecret,
              refreshToken: driveOAuth.refreshToken,
              folderId: driveOAuth.folderId,
              uploadUrl: driveUrl,
              token: driveToken,
            });
          }}
        >
          حفظ Drive
        </button>
        <Badge tone={s.drive_config?.configured ? 'ok' : 'warn'}>{s.drive_config?.configured ? 'مهيأ' : 'غير مهيأ'}</Badge>
      </div>
      <p className="muted">
        الربط الأصلي: Client ID و Client Secret و Refresh Token (نطاق drive.file) — تُجدد الرموز تلقائياً قبل كل نسخة. بعدها جرّب من صفحة المزامنة ← "رفع إلى Drive".
      </p>
    </div>
  );
}

function UsersTab() {
  const { user: me } = useAuth();
  const [rows, setRows] = useState<any[]>([]);
  const [perms, setPerms] = useState<string[]>([]);
  const [form, setForm] = useState({ email: '', password: '', name: '', role: 'cashier' });
  const [editing, setEditing] = useState<any>(null);
  const [toast, showToast] = useToast();

  const load = () => {
    api<any[]>('/users').then(setRows).catch((e) => showToast((e as Error).message, 'bad'));
    api<string[]>('/users/perms').then(setPerms);
  };
  useEffect(() => { void load(); }, []);

  const create = async () => {
    try {
      await api('/users', { method: 'POST', body: form });
      showToast('أُنشئ المستخدم'); setForm({ email: '', password: '', name: '', role: 'cashier' }); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const saveOverrides = async (u: any, perm: string, val: boolean) => {
    const override = { ...(u.permissionsOverride ?? {}), [perm]: val };
    try {
      await api(`/users/${u.id}`, { method: 'PATCH', body: { permissionsOverride: override } });
      showToast('حُفظ تجاوز الصلاحية'); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const toggleActive = async (u: any) => {
    try {
      await api(`/users/${u.id}`, { method: 'PATCH', body: { isActive: !u.isActive } });
      load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  const resetPassword = async (u: any) => {
    const pwd = prompt('كلمة المرور الجديدة:');
    if (!pwd) return;
    try {
      await api(`/users/${u.id}/password`, { method: 'POST', body: { password: pwd } });
      showToast('غُيّرت كلمة المرور');
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div>
      {toast}
      <div className="row2 wrap">
        <input placeholder="البريد" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input placeholder="كلمة المرور" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <input placeholder="الاسم" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {['manager', 'accountant', 'cashier', 'inventory'].map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button className="btn" onClick={create} disabled={!form.email || !form.password || !form.name}>+ مستخدم</button>
      </div>
      {rows.map((u) => (
        <div key={u.id} className="user-card">
          <div className="row-between">
            <strong>{u.name}</strong>
            <div className="row2">
              <Badge tone={u.isActive ? 'ok' : 'bad'}>{u.isActive ? 'نشط' : 'معطل'}</Badge>
              <span className="muted">{u.email} · {u.role}</span>
              <button className="btn secondary small" onClick={() => toggleActive(u)}>{u.isActive ? 'تعطيل' : 'تفعيل'}</button>
              <button className="btn secondary small" onClick={() => resetPassword(u)}>كلمة المرور</button>
              <button className="btn secondary small" onClick={() => setEditing(editing?.id === u.id ? null : u)}>صلاحيات</button>
            </div>
          </div>
          {editing?.id === u.id && (
            <div className="perm-grid">
              {perms.map((p) => {
                const override = (u.permissionsOverride ?? {})[p];
                return (
                  <label key={p} className="perm-item">
                    <input
                      type="checkbox"
                      checked={override !== undefined ? override : true}
                      onChange={(e) => saveOverrides(u, p, e.target.checked)}
                    />
                    <span className="mono">{p}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ))}
      <p className="muted">ملاحظة: المدير لديه كل الصلاحيات — التجاوزات تظهر للمستخدمين الآخرين. أنت مسجل كـ: {me?.role}</p>
    </div>
  );
}

function BranchesTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [toast, showToast] = useToast();

  const load = () => api<any[]>('/org/branches').then(setRows).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    try {
      await api('/org/branches', { method: 'POST', body: { name } });
      showToast('أُنشئ الفرع'); setName(''); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div>
      {toast}
      <div className="row2">
        <input placeholder="اسم الفرع" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" onClick={create} disabled={!name}>+ فرع</button>
      </div>
      <table className="grid">
        <thead><tr><th>الفرع</th><th>العنوان</th><th>هاتف</th></tr></thead>
        <tbody>{rows.map((b) => <tr key={b.id}><td>{b.name}</td><td>{b.address ?? '—'}</td><td>{b.phone ?? '—'}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function MaintenanceTab() {
  const { can } = useAuth();
  const [s, setS] = useState<Record<string, any>>({});
  const [toast, showToast] = useToast();
  const [busy, setBusy] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [safety, setSafety] = useState('');

  const load = () => api<Record<string, any>>('/settings').then(setS).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  const wipeDone = !!s.demo_wipe_done?.done;

  const doExport = async () => {
    setBusy(true);
    try {
      await downloadApi('/system/export-zip', 'medad-export.zip');
      showToast('نُزّلت النسخة (ZIP) — احتُفظ بنسخة في مجلد النسخ أيضاً');
    } catch (e) { showToast((e as Error).message, 'bad'); }
    finally { setBusy(false); }
  };

  return (
    <div>
      {toast}
      {can('backup.view') && (
        <div className="card">
          <h4>تنزيل نسخة كاملة (ZIP)</h4>
          <p className="muted">تشمل قاعدة البيانات + صور الأصناف. تُحفظ نسخة في مجلد النسخ وتُحترم سياسة الاحتفاظ.</p>
          <button className="btn" onClick={doExport} disabled={busy}>{busy ? 'جارٍ التجهيز...' : 'تنزيل ZIP الآن'}</button>
        </div>
      )}
      {can('system.wipe') && (
        <div className="card">
          <h4>استيراد نسخة (استبدال كامل)</h4>
          <p className="muted">يستبدل كل البيانات الحالية بمحتوى ZIP بعد أخذ نسخة أمان تلقائية. متاح دائماً للطوارئ.</p>
          <button className="btn secondary" onClick={() => setImportOpen(true)}>استيراد ZIP...</button>
          {safety && <div className="alert ok">تم الاستيراد — نسخة الأمان: <span className="mono small">{safety}</span> — حدّث الصفحة.</div>}
        </div>
      )}
      {can('system.wipe') && (
        <div className="card">
          <h4>منطقة الخطر — حذف البيانات التجريبية (لمرة واحدة)</h4>
          {wipeDone ? (
            <div className="alert warn">تم تصفير البيانات بتاريخ {s.demo_wipe_done?.at ? new Date(s.demo_wipe_done.at).toLocaleString('ar') : '—'} — لا يمكن إعادة الاستخدام. التراجع عبر استيراد نسخة ZIP.</div>
          ) : (
            <>
              <p className="muted">يحذف الأصناف/المخزون/الحركات ويُبقي التأسيس (المستأجر/الفروع/المستخدمين/الدليل/السنوات/الإعدادات).</p>
              <button className="btn danger" onClick={() => setWipeOpen(true)}>حذف كافة البيانات التجريبية (لمرة واحدة)</button>
            </>
          )}
        </div>
      )}
      {wipeOpen && <WipeModal onClose={() => setWipeOpen(false)} onDone={() => { setWipeOpen(false); load(); }} />}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onDone={(sb) => { setSafety(sb); setImportOpen(false); }} />}
    </div>
  );
}

function WipeModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [, showToast] = useToast();
  const [phrase, setPhrase] = useState('');
  const [ack, setAck] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const valid = phrase === 'حذف نهائي' && ack && password.length > 0;

  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await api('/system/wipe-demo', { method: 'POST', body: { password, confirmPhrase: phrase, acknowledge: ack } });
      showToast('حُذفت البيانات التجريبية — ابدأ ببيانات حقيقية نظيفة');
      onDone();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="تأكيد حذف البيانات التجريبية" onClose={onClose}>
      <div className="alert bad">عملية نهائية لا يمكن التراجع عنها إلا باستعادة نسخة ZIP. تُحذف الأصناف والصور والمخزون والحركات.</div>
      <Field label="اكتب عبارة التأكيد: حذف نهائي">
        <input value={phrase} onChange={(e) => setPhrase(e.target.value)} dir="rtl" />
      </Field>
      <label><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> أفهم أن الحذف نهائي ولا رجعة فيه</label>
      <Field label="كلمة مرور المدير">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" />
      </Field>
      {err && <div className="alert bad">{err}</div>}
      <div className="row2">
        <button className="btn danger" onClick={submit} disabled={!valid || busy}>{busy ? 'جارٍ الحذف...' : 'حذف نهائي'}</button>
        <button className="btn secondary" onClick={onClose}>إلغاء</button>
      </div>
    </Modal>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: (safety: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [phrase, setPhrase] = useState('');
  const [ack, setAck] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const valid = !!file && phrase === 'استعادة' && ack && password.length > 0;

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setErr('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('password', password);
      form.append('confirmPhrase', phrase);
      form.append('acknowledge', 'true');
      const res = await uploadApi<{ safetyBackup: string }>('/system/import-zip', form);
      onDone(res.safetyBackup);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="استيراد نسخة ZIP" onClose={onClose}>
      <div className="alert warn">يستبدل كل البيانات الحالية نهائياً (بعد أخذ نسخة أمان تلقائية من الوضع الحالي).</div>
      <Field label="ملف النسخة (.zip)">
        <input type="file" accept=".zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      {file && <p className="muted">{file.name} — {(file.size / 1024 / 1024).toFixed(2)} MB</p>}
      <Field label="اكتب عبارة التأكيد: استعادة">
        <input value={phrase} onChange={(e) => setPhrase(e.target.value)} dir="rtl" />
      </Field>
      <label><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> أفهم أن الاستيراد سيستبدل كل البيانات الحالية نهائياً</label>
      <Field label="كلمة مرور المدير">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" />
      </Field>
      {err && <div className="alert bad">{err}</div>}
      <div className="row2">
        <button className="btn" onClick={submit} disabled={!valid || busy}>{busy ? 'جارٍ الاستيراد...' : 'استيراد واستبدال'}</button>
        <button className="btn secondary" onClick={onClose}>إلغاء</button>
      </div>
    </Modal>
  );
}
