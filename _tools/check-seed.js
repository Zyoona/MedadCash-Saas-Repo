const { Client } = require('pg');

const c = new Client({ connectionString: process.env.DATABASE_URL });

async function main() {
  await c.connect();
  for (const t of ['tenants', 'branches', 'accounts', 'users', 'customers', 'fiscal_years', 'settings']) {
    const r = await c.query(`SELECT COUNT(*) AS n FROM "${t}"`);
    console.log(`${t}: ${r.rows[0].n}`);
  }
  await c.end();
}

main().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
