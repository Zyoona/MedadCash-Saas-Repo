// سكربت مؤقت: تشغيل القاعدة + توليد عميل Prisma + تطبيق الهجرات + التحقق
const { spawnSync } = require('child_process')
const path = require('path')

const ROOT = 'F:/مداد/MedadCash'
const API = path.join(ROOT, 'apps/api')
const CLI = path.join(API, 'node_modules/prisma/build/index.js')
const SCHEMA = path.join(API, 'prisma/schema.prisma')

const run = (args, opts = {}) => {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', ...opts })
  console.log('[run] ' + args.join(' ') + ' → exit ' + r.status)
  return r.status ?? 1
}

const connect = async () => {
  const { Client } = require(path.join(ROOT, 'node_modules/pg'))
  const c = new Client({ user: 'medad', password: 'medad', host: 'localhost', port: 5433, database: 'medad' })
  await c.connect()
  return c
}

const waitUp = async (tries = 40) => {
  for (let i = 0; i < tries; i++) {
    try { const c = await connect(); await c.query('SELECT 1'); await c.end(); return true } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

const main = async () => {
  run([path.join(ROOT, '_tools/pg-run.js'), 'start'], { cwd: ROOT })
  const up = await waitUp()
  console.log('[db] up = ' + up)
  if (!up) process.exit(1)

  const env = { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') }
  run([CLI, 'generate', '--schema', SCHEMA], { cwd: API, env })
  run([CLI, 'migrate', 'deploy', '--schema', SCHEMA], { cwd: API, env })

  const c = await connect()
  const drawers = await c.query('SELECT count(*)::int AS n FROM cash_drawers')
  const accs = await c.query("SELECT code, name, type FROM accounts WHERE code IN ('1010','1011','5310') ORDER BY code")
  const cols = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='shifts' ORDER BY ordinal_position")
  const idx = await c.query("SELECT indexname FROM pg_indexes WHERE tablename IN ('cash_drawers','shifts') ORDER BY indexname")
  const mig = await c.query("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name")
  console.log('[check] cash_drawers rows = ' + drawers.rows[0].n)
  console.log('[check] accounts = ' + JSON.stringify(accs.rows))
  console.log('[check] shifts columns = ' + cols.rows.map((r) => r.column_name).join(', '))
  console.log('[check] indexes = ' + idx.rows.map((r) => r.indexname).join(', '))
  console.log('[check] migrations = ' + mig.rows.map((r) => r.migration_name).join(', '))
  await c.end()
}

main().catch((e) => { console.error('ERR', e); process.exit(1) })
