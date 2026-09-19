import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Field, useToast } from '../ui.js';
import { useAuth } from '../auth.js';

export function Settings() {
  const [tab, setTab] = useState('general');
  return (
    <div className="card">
      <h2>الإعدادات</h2>
      <div className="tabs">
        {[['general', 'عامة'], ['users', 'المستخدمون والصلاحيات'], ['branches', 'الفروع']].map(([id, label]) => (
          <button key={id} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'general' && <GeneralTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'branches' && <BranchesTab />}
    </div>
  );
}

function GeneralTab() {
  const [s, setS] = useState<Record<string, any>>({});
  const [driveUrl, setDriveUrl] = useState('');
  const [driveToken, setDriveToken] = useState('');
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
        <input placeholder="uploadUrl" value={driveUrl} onChange={(e) => setDriveUrl(e.target.value)} />
        <input placeholder="token" type="password" value={driveToken} onChange={(e) => setDriveToken(e.target.value)} />
        <button className="btn" onClick={() => save('drive_config', { configured: !!driveUrl && !!driveToken, uploadUrl: driveUrl, token: driveToken })}>حفظ Drive</button>
        <Badge tone={s.drive_config?.configured ? 'ok' : 'warn'}>{s.drive_config?.configured ? 'مهيأ' : 'غير مهيأ'}</Badge>
      </div>
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
