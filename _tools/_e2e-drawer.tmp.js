// فحص حي شامل (E2E) لنموذج درج العهدة على قاعدة التطوير — يفتح وردية ويغلقها بفائض مقصود
const { spawnSync, spawn } = require('child_process')
const path = require('path')

const ROOT = 'F:/مداد/MedadCash'
const API = path.join(ROOT, 'apps/api')
const base = 'http://127.0.0.1:3000/api'

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
  console.log('[db] up')

  const build = spawnSync('npx.cmd', ['nest', 'build'], { cwd: API, stdio: 'inherit', shell: true })
  if (build.status !== 0) throw new Error('nest build failed')

  const child = spawn(process.execPath, ['dist/main'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await waitForApi(child)

    const login = await j('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@medad.local', password: 'Medad@123' }) })
    const token = login.body?.accessToken
    if (!token) throw new Error('login failed: ' + JSON.stringify(login.body))
    const H = { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
    console.log('[login] ok, perms include pos.shift_any =', (login.body.user?.perms ?? []).includes('pos.shift_any'))

    const branches = await j('/org/branches', { headers: H })
    const mainBranch = (branches.body ?? []).find((b) => b.name.includes('الرئيسي')) ?? branches.body?.[0]
    console.log('[branch]', mainBranch?.name, mainBranch?.id)

    const FLOAT = 12345 // 123.45 ₪
    const opened = await j('/sales/shifts/open', { method: 'POST', headers: H, body: JSON.stringify({ branchId: mainBranch.id, openingAmountAgora: FLOAT }) })
    console.log('[open]', opened.status, JSON.stringify({ id: opened.body?.id?.slice(0, 8), drawer: opened.body?.drawerAccountCode, expected: opened.body?.expectedAgora, entryId: opened.body?.entryId, warnings: opened.body?.warnings, message: opened.body?.message }))
    const shiftId = opened.body?.id
    if (!shiftId) throw new Error('open failed — aborting')

    const panel = await j('/sales/shifts/panel?branchId=' + mainBranch.id, { headers: H })
    console.log('[panel]', panel.status, JSON.stringify(panel.body))

    const SURPLUS = 100 // فائض 1.00 ₪ مقصود لاختبار ترحيل 5310
    const closed = await j(`/sales/shifts/${shiftId}/close`, { method: 'POST', headers: H, body: JSON.stringify({ closingActualAgora: FLOAT + SURPLUS }) })
    console.log('[close]', closed.status, JSON.stringify({
      expected: closed.body?.expectedAgora, diff: closed.body?.diffAgora, basis: closed.body?.basis,
      drawer: closed.body?.drawerAccountCode, entryId: closed.body?.entryId, box: closed.body?.boxBalanceAgora,
      warnings: closed.body?.warnings, message: closed.body?.message,
    }))

    const rep = await j(`/sales/shifts/${shiftId}/report`, { headers: H })
    console.log('[report]', rep.status, JSON.stringify({ shift: rep.body?.shift, cash: rep.body?.cash, warnings: rep.body?.warnings }))

    const sum = await j('/dashboard/summary', { headers: H })
    console.log('[dashboard]', sum.status, JSON.stringify({ cashAgora: sum.body?.cashAgora, drawerCashAgora: sum.body?.drawerCashAgora, trialBalance: sum.body?.trialBalance, openShift: sum.body?.openShift ? { id: sum.body.openShift.id.slice(0, 8), opening: sum.body.openShift.openingAmountAgora } : null }))

    const ent = await j(`/ledger/entries/${closed.body?.entryId}`, { headers: H })
    console.log('[entry shift_close]', ent.status, JSON.stringify((ent.body?.lines ?? []).map((l) => [l.account?.code, l.account?.name, String(l.debit), String(l.credit)])))
    const ent2 = await j(`/ledger/entries/${opened.body?.entryId}`, { headers: H })
    console.log('[entry shift_open]', ent2.status, JSON.stringify((ent2.body?.lines ?? []).map((l) => [l.account?.code, String(l.debit), String(l.credit)])))

    // تحقق مباشر من الدفتر: رصيد الدرج يجب أن يعود صفراً
    const c = await connect()
    const drawerBal = await c.query(`
      SELECT a.code, SUM(l.debit - l.credit)::numeric(18,2) AS balance
      FROM journal_lines l JOIN accounts a ON a.id = l."accountId" JOIN journal_entries e ON e.id = l."entryId"
      WHERE a.code LIKE '101%' AND e."tenantId" = a."tenantId"
      GROUP BY a.code ORDER BY a.code`)
    console.log('[drawer balances]', JSON.stringify(drawerBal.rows))
    const tb = await c.query('SELECT SUM(debit)::numeric(18,2) AS dr, SUM(credit)::numeric(18,2) AS cr FROM journal_lines')
    console.log('[trial balance]', JSON.stringify(tb.rows))
    const drawers = await c.query('SELECT d."glAccountCode", u.email, a.name FROM cash_drawers d JOIN users u ON u.id = d."cashierId" JOIN accounts a ON a.code = d."glAccountCode" ORDER BY d."glAccountCode"')
    console.log('[cash_drawers]', JSON.stringify(drawers.rows))
    await c.end()
  } finally {
    child.kill('SIGTERM')
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
