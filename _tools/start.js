// _tools/start.js — Node.js orchestrator to replace complex VBScript
// Launched by a minimal VBScript or shortcut; single process, no hidden cmd spam
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const LOGS = path.join(ROOT, '_tools', 'logs');

function log(msg) {
  const ts = new Date().toLocaleTimeString('ar-EG');
  console.log(`[${ts}] ${msg}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { 
      cwd: ROOT, 
      stdio: 'pipe',
      windowsHide: true,
      shell: true,
      ...opts 
    });
    let out = '';
    child.stdout?.on('data', d => out += d);
    child.stderr?.on('data', d => out += d);
    child.on('close', code => resolve({ code, out }));
    child.on('error', err => resolve({ code: -1, out: err.message }));
  });
}

function httpGet(url, timeout = 2000) {
  return new Promise(resolve => {
    const req = http.get(url, res => { res.resume(); resolve(res.statusCode < 500); });
    req.setTimeout(timeout, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitFor(url, label, maxAttempts = 60, interval = 1000) {
  for (let i = 0; i < maxAttempts; i++) {
    if (await httpGet(url)) { log(`${label} ready`); return true; }
    await new Promise(r => setTimeout(r, interval));
  }
  log(`${label} timeout`);
  return false;
}

function trimLog(name) {
  try {
    const f = path.join(LOGS, name);
    if (fs.existsSync(f) && fs.statSync(f).size > 4 * 1024 * 1024) fs.unlinkSync(f);
  } catch {}
}

// تشغيل عملية dev server مثل VBScript الأصلي: استخدم spawn مع shell: true و detached
function spawnDevServer(name, npmScript, logFile) {
  const logPath = path.join(LOGS, logFile);
  // استخدام npm مباشرة مع shell: true و detached - يعمل مثل sh.Run في VBScript
  const child = spawn('npm', ['run', npmScript], {
    cwd: ROOT,
    stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
    windowsHide: true,
    detached: true,
    shell: true
  });
  child.unref();
  log(`Started ${name} (logged to ${logFile})`);
  return child;
}

async function main() {
  log('=== مداد — بدء التشغيل ===');
  
  ['api.log', 'web.log', 'splash.log', 'migrate.log', 'pg-start.log'].forEach(trimLog);
  if (!fs.existsSync(LOGS)) fs.mkdirSync(LOGS, { recursive: true });

  // 1) Splash first
  log('Starting splash...');
  const splash = spawn('node', [path.join(__dirname, 'splash-server.js')], { 
    cwd: ROOT, stdio: 'ignore', detached: true, windowsHide: true });
  splash.unref();
  await waitFor('http://127.0.0.1:5199/', 'Splash', 20, 500);
  spawn('cmd', ['/c', 'start', '', 'http://127.0.0.1:5199/'], { windowsHide: true });

  // 2) Shared types
  if (!fs.existsSync(path.join(ROOT, 'packages/shared-types/dist/index.js'))) {
    log('Building shared-types...');
    await run('npm', ['run', 'build', '-w', 'packages/shared-types']);
  }

  // 3) Prisma generate
  const client = path.join(ROOT, 'node_modules/.prisma/client/index.js');
  const schema = path.join(ROOT, 'apps/api/prisma/schema.prisma');
  if (!fs.existsSync(client) || (fs.existsSync(schema) && fs.statSync(schema).mtime > fs.statSync(client).mtime)) {
    log('Generating Prisma client...');
    await run('npm', ['run', 'prisma:generate']);
  }

  // 4) PostgreSQL
  log('Starting PostgreSQL...');
  const pgStart = spawnSync('node', [path.join(__dirname, 'pg-run.js'), 'start'], { 
    cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout: 120000 });
  if (pgStart.status !== 0) { log('PostgreSQL start failed'); process.exit(1); }
  for (let i = 0; i < 45; i++) {
    const r = spawnSync('node', [path.join(__dirname, 'pg-run.js'), 'status'], { cwd: ROOT, windowsHide: true });
    if (r.status === 0) { log('PostgreSQL ready'); break; }
    await new Promise(r => setTimeout(r, 2000));
  }

  // 5) .env
  const envPath = path.join(ROOT, 'apps/api/.env');
  if (!fs.existsSync(envPath)) {
    const example = path.join(ROOT, 'apps/api/.env.example');
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, envPath);
    } else {
      fs.writeFileSync(envPath, 'DATABASE_URL="postgresql://medad:medad@localhost:5433/medad?schema=public"\n');
    }
  }

  // 6) Migrations (conditional)
  const migRoot = path.join(ROOT, 'apps/api/prisma/migrations');
  let sig = '';
  if (fs.existsSync(migRoot)) {
    sig = fs.readdirSync(migRoot).filter(f => fs.statSync(path.join(migRoot, f)).isDirectory()).sort().join(';');
  }
  const sigFile = path.join(LOGS, 'migrations.marker');
  let needMigrate = true;
  if (fs.existsSync(sigFile)) needMigrate = fs.readFileSync(sigFile, 'utf8') !== sig;
  if (needMigrate) {
    log('Running migrations...');
    await run('npm', ['run', 'db:migrate']);
    fs.writeFileSync(sigFile, sig);
  }

  // 7) API + Web in parallel (using cmd /c pattern like original VBScript)
  spawnDevServer('API', 'dev:api', 'api.log');
  spawnDevServer('Web', 'dev:web', 'web.log');

  // 8) Wait for web; if splash dead, open web directly
  await waitFor('http://127.0.0.1:5173/', 'Web', 60, 1000);
  const splashAlive = await httpGet('http://127.0.0.1:5199/');
  if (!splashAlive) {
    spawn('cmd', ['/c', 'start', '', 'http://127.0.0.1:5173/'], { windowsHide: true });
  }

  // 9) Monitor API for error reporting
  const apiReady = await waitFor('http://127.0.0.1:3000/api/health', 'API', 90, 2000);
  if (!apiReady) {
    log('WARNING: API did not become healthy in time');
  }

  log('=== بدء التشغيل اكتمل ===');
  // Keep process alive to hold child processes
  setInterval(() => {}, 1000 * 60 * 60);
}

main().catch(e => { log('FATAL: ' + e.message); process.exit(1); });