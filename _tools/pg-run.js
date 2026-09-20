// Persistent local Postgres runner: keeps running (no auto-shutdown).
// Launches postgres.exe inside a hidden console (via pg-launch.vbs) so that all
// of its child processes (checkpointer, bgwriter, io_worker, ...) share that
// hidden console instead of each opening its own visible console window.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// كل المسارات مشتقة من موقع هذا الملف (جذر المشروع = المجلد الأب لـ _tools)
// حتى يعمل النظام من أي قرص/مسار على أي جهاز دون تعديل.
const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin');
const DATA = path.join(ROOT, '_tools', 'pgsql', 'data');
const LOG = path.join(ROOT, '_tools', 'pgsql', 'postgres.log');
const POSTMASTER_PID = path.join(DATA, 'postmaster.pid');
const LAUNCHER = path.join(__dirname, 'pg-launch.vbs');
const PORT = '5433';

const cmd = process.argv[2] || 'start';

function readPid() {
  try {
    const pid = fs.readFileSync(POSTMASTER_PID, 'utf8').split(/\r?\n/)[0].trim();
    // قيمة الملف غير موثوقة: أرقام فقط، وإلا نتجاهلها (لا تمرر أبداً للشل)
    if (/^\d+$/.test(pid)) return pid;
  } catch (e) {}
  return null;
}

function pidIsPostgres(pid) {
  if (!pid) return false;
  try {
    const res = spawnSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { encoding: 'utf8' });
    return /postgres\.exe/i.test(res.stdout || '');
  } catch (e) {
    return false;
  }
}

function clearPidFiles() {
  try { fs.unlinkSync(POSTMASTER_PID); } catch (e) {}
}

if (cmd === 'start') {
  if (!fs.existsSync(path.join(DATA, 'PG_VERSION'))) {
    console.error('[pg] data dir not initialised — run pg-local.js start first');
    process.exit(1);
  }
  const existing = readPid();
  if (pidIsPostgres(existing)) {
    console.log('[pg] already running, pid=' + existing);
    process.exit(0);
  }
  const res = spawnSync('wscript.exe', [LAUNCHER, path.join(BIN, 'postgres.exe'), DATA, PORT, LOG], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (res.error) {
    console.error('[pg] failed to launch postgres:', res.error.message);
    process.exit(1);
  }
  console.log('[pg] postgres start requested, port=' + PORT);
} else if (cmd === 'stop') {
  const pid = readPid();
  if (!pidIsPostgres(pid)) {
    clearPidFiles();
    console.log('[pg] postgres is not running');
    process.exit(0);
  }
  try {
    const res = spawnSync('taskkill', ['/pid', pid, '/f', '/t'], { encoding: 'utf8' });
    if (res.status === 0) console.log('[pg] stopped pid=' + pid);
    else console.log('[pg] stop:', (res.stderr || '').trim());
  } catch (e) {
    console.log('[pg] stop:', e.message);
  }
  clearPidFiles();
} else if (cmd === 'status') {
  const { Client } = require('pg');
  const c = new Client({ user: 'medad', password: 'medad', host: 'localhost', port: 5433, database: 'medad' });
  c.connect()
    .then(() => c.query('SELECT 1 AS ok'))
    .then((r) => {
      console.log('[pg] UP', JSON.stringify(r.rows));
      return c.end();
    })
    .catch((e) => {
      console.log('[pg] DOWN', e.message);
      process.exit(1);
    });
}
