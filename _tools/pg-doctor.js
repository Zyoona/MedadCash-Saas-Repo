// تشخيص جاهزية PostgreSQL — يعمل من أي قرص/مسار.
// الاستخدام على الجهاز الآخر:  node _tools\pg-doctor.js
// اطبع الناتج كاملاً لتحديد سبب الفشل بدقة.
const fs = require('fs');
const path = require('path');

console.log('=== medad pg-doctor v2 (project-relative paths) ===');
console.log('node        :', process.version, '|', process.platform, process.arch);
console.log('script dir  :', __dirname);

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, '_tools', 'pgsql', 'data');
const BIN = path.join(ROOT, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin');
const PG_EXE = path.join(BIN, 'postgres.exe');
const INITDB_EXE = path.join(BIN, 'initdb.exe');
const LOG = path.join(ROOT, '_tools', 'pgsql', 'postgres.log');

console.log('project root:', ROOT);
console.log('data dir    :', fs.existsSync(DATA), '->', DATA);
console.log('PG_VERSION  :', fs.existsSync(path.join(DATA, 'PG_VERSION')));
console.log('postgres.exe:', fs.existsSync(PG_EXE), '->', PG_EXE);
console.log('initdb.exe  :', fs.existsSync(INITDB_EXE), '->', INITDB_EXE);
console.log('postgres.log:', fs.existsSync(LOG), '->', LOG);

for (const mod of ['embedded-postgres', 'pg']) {
  try {
    require.resolve(mod, { paths: [ROOT] });
    console.log('module      :', mod, '-> OK');
  } catch (e) {
    console.log('module      :', mod, '-> MISSING');
  }
}

const pidFile = path.join(DATA, 'postmaster.pid');
console.log('postmaster  :', fs.existsSync(pidFile) ? 'pid file present' : '(no pid file)');

// علامة النسخة: وجود هذه الدالة يعني أن ملف pg-local.js المحدَّث موجود بجانب pg-doctor.js
const setupMarker = fs.existsSync(path.join(ROOT, '_tools', 'pg-local.js'))
  && fs.readFileSync(path.join(ROOT, '_tools', 'pg-local.js'), 'utf8').includes("cmd === 'setup'");
console.log('pg-local.js setup command:', setupMarker ? 'PRESENT (new code)' : 'MISSING (old code)');

const runMarker = fs.existsSync(path.join(ROOT, '_tools', 'pg-run.js'))
  && fs.readFileSync(path.join(ROOT, '_tools', 'pg-run.js'), 'utf8').includes('running first-time setup');
console.log('pg-run.js auto-setup    :', runMarker ? 'PRESENT (new code)' : 'MISSING (old code)');
