// فحص حي للقراءة فقط: تقرير وردية مغلقة بدرج + لوحة وردية قديمة + ملخص اللوحة
const { spawnSync, spawn } = require('child_process')
const path = require('path')

const ROOT = 'F:/مداد/MedadCash'
const API = path.join(ROOT, 'apps/api')
const base = 'http://127.0.0.1:3000/api'
const CLOSED_DRAWER_SHIFT = 'ba55b014-621d-488d-ae2c-d32281780d5a'

const j = async (p, opts) => {
  const res = await fetch(base + p, opts)
  const text = await res.text()
  let body = text
  try { body = JSON.parse(text) } catch { /* keep text */ }
  return { status: res.status, body }
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

const waitForApi = (child) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('API did not start in time')), 90000)
  child.stdout.on('data', (d) => { if (String(d).includes('listening on')) { clearTimeout(t); resolve() } })
  child.stderr.on('data', (d) => process.stderr.write(String(d)))
  child.on('exit', (code) => { clearTimeout(t); reject(new Error('API exited early code=' + code)) })
})

const main = async () => {
  spawnSync(process.execPath, [path.join(ROOT, '_tools/pg-run.js'), 'start'], { cwd: ROOT, stdio: 'inherit' })
  if (!(await waitUp())) throw new Error('database not up')
  const build = spawnSync('npx.cmd', ['nest', 'build'], { cwd: API, stdio: 'inherit', shell: true })
  if (build.status !== 0) throw new Error('nest build failed')

  const child = spawn(process.execPath, ['dist/main'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await waitForApi(child)
    const login = async (email) => {
      const r = await j('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Medad@123' }) })
      return { authorization: 'Bearer ' + r.body?.accessToken }
    }
    const admin = await login('admin@medad.local')
    const rana = await login('rana@medad.local')

    const rep = await j('/sales/shifts/' + CLOSED_DRAWER_SHIFT + '/report', { headers: admin })
    console.log('[report closed drawer shift]', rep.status, JSON.stringify({ cash: rep.body?.cash, warnings: rep.body?.warnings }))

    const panel = await j('/sales/shifts/panel', { headers: rana })
    console.log('[panel rana legacy]', panel.status, JSON.stringify(panel.body))

    const sum = await j('/dashboard/summary', { headers: admin })
    console.log('[dashboard]', sum.status, JSON.stringify({ cashAgora: sum.body?.cashAgora, drawerCashAgora: sum.body?.drawerCashAgora, trialBalance: sum.body?.trialBalance }))

    const perms = await j('/users/perms', { headers: admin })
    console.log('[perms] pos.shift_any listed =', JSON.stringify(perms.body).includes('pos.shift_any'))
  } finally {
    child.kill('SIGTERM')
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
