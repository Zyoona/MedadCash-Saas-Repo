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
const PG_CTL = path.join(BIN, 'pg_ctl.exe');
const PORT = '5433';

const cmd = process.argv[2] || 'start';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    const res = spawnSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { 
      encoding: 'utf8', 
      windowsHide: true,
      timeout: 3000 
    });
    if (res.error) return false;
    return /postgres\.exe/i.test(res.stdout || '');
  } catch (e) {
    return false;
  }
}

function clearPidFiles() {
  try { fs.unlinkSync(POSTMASTER_PID); } catch (e) {}
}

// فحص وجود PG_VERSION مع إعادة المحاولة (تجنب مشاكل التخزين المؤقت/التزامن)
function dataDirInitialised() {
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(DATA, 'PG_VERSION'))) return true;
    if (i < 4) { /* small delay */ }
  }
  return false;
}

async function waitForPostgresReady(maxAttempts = 30, intervalMs = 1000) {
  const { Client } = require('pg');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const c = new Client({ user: 'medad', password: 'medad', host: 'localhost', port: 5433, database: 'medad', connectionTimeoutMillis: 3000 });
    try {
      await c.connect();
      await c.query('SELECT 1 AS ok');
      await c.end();
      return true;
    } catch (e) {
      await c.end().catch(() => {});
      if (attempt < maxAttempts - 1) await sleep(intervalMs);
    }
  }
  return false;
}

if (cmd === 'start') {
  if (!dataDirInitialised()) {
    // تهيئة تلقائية عند أول تشغيل على جهاز/مسار جديد — لا حاجة لأي خطوة يدوية.
    console.log('[pg] data dir not initialised at: ' + DATA);
    console.log('[pg] running first-time setup (initdb + create medad)...');
    const setup = spawnSync(process.execPath, [path.join(__dirname, 'pg-local.js'), 'setup'], { 
      stdio: 'inherit',
      windowsHide: true,
      timeout: 120000 
    });
    if (setup.error || setup.status !== 0) {
      console.error('[pg] first-time setup failed. data dir: ' + DATA);
      process.exit(1);
    }
    if (!dataDirInitialised()) {
      console.error('[pg] setup finished but data dir is still not initialised: ' + DATA);
      process.exit(1);
    }
  }
  const existing = readPid();
  if (pidIsPostgres(existing)) {
    console.log('[pg] already running, pid=' + existing);
    process.exit(0);
  }
  // تأكد من وجود ملف السجل ومجلده
  try { 
    if (!fs.existsSync(path.dirname(LOG))) fs.mkdirSync(path.dirname(LOG), { recursive: true });
    if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, '');
  } catch (e) {}
  const res = spawnSync('wscript.exe', [LAUNCHER, PG_CTL, DATA, PORT, LOG], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 10000
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
    const res = spawnSync('taskkill', ['/pid', pid, '/f', '/t'], { 
      encoding: 'utf8', 
      windowsHide: true,
      timeout: 10000 
    });
    if (res.status === 0) console.log('[pg] stopped pid=' + pid);
    else console.log('[pg] stop:', (res.stderr || '').trim() || 'taskkill failed');
  } catch (e) {
    console.log('[pg] stop:', e.message);
  }
  clearPidFiles();
} else if (cmd === 'status') {
  (async () => {
    const ready = await waitForPostgresReady(10, 500);
    if (ready) {
      console.log('[pg] UP');
      process.exit(0);
    } else {
      console.log('[pg] DOWN');
      process.exit(1);
    }
  })();
}