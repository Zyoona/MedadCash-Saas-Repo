// فحص تشخيصي (قراءة فقط): إسناد الفواتير للوردية/الفرع + شكل /accounts + حساب 5310
const base = 'http://127.0.0.1:3000/api'

const j = async (path, opts) => {
  const res = await fetch(base + path, opts)
  const text = await res.text()
  let body = text
  try { body = JSON.parse(text) } catch { /* keep text */ }
  return { status: res.status, body }
}

const SHIFT = '774f8d11-80b0-466b-86c9-f7a0c1497c4b'

const main = async () => {
  const login = await j('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@medad.local', password: 'Medad@123' }),
  })
  const token = login.body?.accessToken
  if (!token) { console.log('LOGIN failed', login.status, JSON.stringify(login.body)); return }
  const H = { authorization: 'Bearer ' + token }

  const users = await j('/users', { headers: H })
  const uArr = Array.isArray(users.body) ? users.body : (users.body?.rows ?? [])
  const uMap = new Map(uArr.map((u) => [u.id, `${u.email}/${u.role}/br=${(u.branchId ?? 'null').slice(0, 8)}`]))
  console.log('USERS', uArr.length)

  const branches = await j('/org/branches', { headers: H })
  const bMap = new Map((branches.body ?? []).map((b) => [b.id, b.name]))
  console.log('BRANCHES', JSON.stringify([...bMap.entries()].map(([id, n]) => [id.slice(0, 8), n])))

  const rep = await j('/sales/shifts/' + SHIFT + '/report', { headers: H })
  console.log('REPORT', rep.status, JSON.stringify(rep.body))

  const inv = await j('/sales/invoices?pageSize=200', { headers: H })
  const rows = inv.body?.rows ?? []
  console.log('INVOICES total', inv.body?.total, 'page rows', rows.length)
  const mine = rows.filter((r) => r.shift?.id === SHIFT || r.shiftId === SHIFT)
  console.log('INVOICES of shift', mine.length)
  for (const r of rows.slice(0, 12)) {
    console.log(' inv', r.id.slice(0, 8), 'branch=', bMap.get(r.branchId ?? r.branch?.id) ?? (r.branchId ?? r.branch?.id ?? '?').slice(0, 8),
      'shift=', (r.shiftId ?? r.shift?.id ?? 'null').toString().slice(0, 8),
      'createdAt=', r.createdAt, 'pay=', JSON.stringify((r.payments ?? []).map((p) => [p.method, p.accountCode, p.amountAgora])))
  }

  const one = rows[0] ? await j('/sales/invoices/' + rows[0].id, { headers: H }) : null
  if (one) console.log('INVOICE detail', JSON.stringify({ id: one.body?.id?.slice(0, 8), branch: one.body?.branch, shift: one.body?.shift, createdAt: one.body?.createdAt, payments: one.body?.payments }))

  const accounts = await j('/accounts', { headers: H })
  const aArr = Array.isArray(accounts.body) ? accounts.body : (accounts.body?.rows ?? [])
  console.log('ACCOUNTS', aArr.length, 'has 5310:', JSON.stringify(aArr.find((a) => a.code === '5310') ?? null))
  console.log('ACCOUNT 1000:', JSON.stringify(aArr.find((a) => a.code === '1000') ?? null))
}

main().catch((e) => { console.error('ERR', e); process.exit(1) })
