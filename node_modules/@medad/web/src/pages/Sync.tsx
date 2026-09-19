import { useEffect, useState } from 'react';
import { api, money } from '../api.js';
import { Badge, Field, useToast } from '../ui.js';

export function Sync() {
  const [tab, setTab] = useState('conflicts');
  return (
    <div className="card">
      <h2>المزامنة والنسخ الاحتياطي — عزل يدوي، لا دمج تلقائي</h2>
      <div className="tabs">
        {[['conflicts', 'صندوق التعارضات'], ['ops', 'سجل العمليات'], ['board', 'لوحة الفروع'], ['backup', 'النسخ الاحتياطي']].map(([id, label]) => (
          <button key={id} className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'conflicts' && <ConflictsTab />}
      {tab === 'ops' && <OpsTab />}
      {tab === 'board' && <BoardTab />}
      {tab === 'backup' && <BackupTab />}
    </div>
  );
}

function ConflictsTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [toast, showToast] = useToast();

  const load = () => api<any[]>('/sync/conflicts?resolved=0').then(setRows).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  const resolve = async (id: string, choice: 'local' | 'remote' | 'custom', value?: unknown) => {
    try {
      await api(`/sync/conflicts/${id}/resolve`, { method: 'POST', body: { choice, value } });
      showToast('حُل التعارض يدوياً — طُبق كعملية جديدة'); load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div>
      {toast}
      {rows.length === 0 && <div className="alert ok">لا تعارضات معلقة</div>}
      {rows.map((c) => (
        <div key={c.id} className="conflict-card">
          <div className="row-between">
            <strong>{c.entity} / {c.entityId.slice(0, 8)}</strong>
            <span className="muted">جهاز: {c.localDevice} · {new Date(c.createdAt).toLocaleString('ar')}</span>
          </div>
          <div className="conflict-values">
            <div>
              <h5>القيمة المحلية (الجهاز)</h5>
              <pre className="mono small">{JSON.stringify(c.localValue, null, 1)}</pre>
            </div>
            <div>
              <h5>القيمة البعيدة (الخادم)</h5>
              <pre className="mono small">{JSON.stringify(c.remoteValue, null, 1)}</pre>
            </div>
          </div>
          <div className="row2">
            <button className="btn small" onClick={() => resolve(c.id, 'local')}>اعتماد المحلي</button>
            <button className="btn secondary small" onClick={() => resolve(c.id, 'remote')}>إبقاء الخادم</button>
            {c.entity === 'customer' && (
              <button className="btn secondary small" onClick={() => {
                const name = prompt('قيمة مخصصة للاسم:');
                if (name) resolve(c.id, 'custom', { name });
              }}>قيمة مخصصة</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function OpsTab() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api<any[]>('/sync/pull').then(setRows).catch(() => undefined); }, []);
  return (
    <table className="grid">
      <thead><tr><th>الوقت</th><th>الفرع</th><th>الجهاز</th><th>الكيان</th><th>عملية</th><th>مطبق</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{new Date(r.createdAt).toLocaleString('ar')}</td>
            <td className="mono">{r.branchId.slice(0, 8)}</td>
            <td>{r.deviceId}</td>
            <td>{r.entity}</td>
            <td>{r.op}</td>
            <td>{r.appliedAt ? '✓' : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BoardTab() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { api<any[]>('/sync/board').then(setRows).catch(() => undefined); }, []);
  return (
    <table className="grid">
      <thead><tr><th>الفرع</th><th>آخر رفع</th><th>الجهاز</th><th>عدد الأجهزة</th><th>تعارضات مفتوحة</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.branch.id}>
            <td>{r.branch.name}</td>
            <td>{r.lastPushAt ? new Date(r.lastPushAt).toLocaleString('ar') : '—'}</td>
            <td>{r.lastPushDevice ?? '—'}</td>
            <td>{r.deviceCount}</td>
            <td>{r.openConflicts}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BackupTab() {
  const [runs, setRuns] = useState<any[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [toast, showToast] = useToast();

  const load = () => api<any[]>('/sync/backup/runs').then(setRuns).catch((e) => showToast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);

  const run = async (provider: string) => {
    try {
      const r = await api<any>('/sync/backup/run', { method: 'POST', body: { provider } });
      showToast(r.status === 'success' ? `نجحت النسخة: ${r.sizeBytes} بايت` : `فشل: ${r.message}`, r.status === 'success' ? 'ok' : 'bad');
      load();
    } catch (e) { showToast((e as Error).message, 'bad'); }
  };

  return (
    <div>
      {toast}
      <div className="row2 wrap">
        <button className="btn" onClick={() => run('local')}>نسخ محلي الآن</button>
        <button className="btn secondary" onClick={() => run('drive')}>رفع إلى Drive</button>
        <button className="btn secondary" onClick={() => setRestoring(!restoring)}>استعادة نسخة (مدير)</button>
      </div>
      {restoring && (
        <div className="row2">
          <select onChange={(e) => {
            const file = e.target.value;
            if (!file) return;
            if (!confirm('الاستعادة تستبدل كل البيانات الحالية بالنسخة! متابعة؟')) return;
            api('/sync/backup/restore', { method: 'POST', body: { filePath: file } })
              .then(() => showToast('استُعيدت النسخة'))
              .catch((er) => showToast((er as Error).message, 'bad'));
          }}>
            <option value="">اختر نسخة...</option>
            {runs.filter((r) => r.status === 'success' && r.filePath).map((r) => (
              <option key={r.id} value={r.filePath}>{new Date(r.startedAt).toLocaleString('ar')} ({r.sizeBytes ? Math.round(r.sizeBytes / 1024) + 'KB' : '?'})</option>
            ))}
          </select>
        </div>
      )}
      <table className="grid">
        <thead><tr><th>الوقت</th><th>المزود</th><th>الحالة</th><th>الحجم</th><th>الرسالة</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.startedAt).toLocaleString('ar')}</td>
              <td>{r.provider}</td>
              <td><Badge tone={r.status === 'success' ? 'ok' : 'bad'}>{r.status === 'success' ? 'نجاح' : 'فشل'}</Badge></td>
              <td>{r.sizeBytes ? money(0).replace(/[^\d]/g, '') && `${Math.round(r.sizeBytes / 1024)} KB` : '—'}</td>
              <td>{r.message ?? r.filePath ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">مهمة يومية تلقائية تعمل كل ساعة وتنسخ عند مرور 24 ساعة على آخر نجاح (قابل للتعطيل من الإعدادات).</p>
    </div>
  );
}
