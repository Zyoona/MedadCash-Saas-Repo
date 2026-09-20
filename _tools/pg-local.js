// Local Postgres bootstrap (all inside MedadCash — no global installs).
// Uses embedded-postgres binaries vendored in node_modules.
// Data lives in _tools/pgsql/data, controlled port 5433 to avoid clashes.
const path = require('path');
const EmbeddedPostgres = require('embedded-postgres').default;

// مسار بيانات Postgres نسبي للمشروع (مجلد _tools بجوار هذا الملف) بدلاً من مسار قرص ثابت.
const DATA_DIR = path.join(__dirname, 'pgsql', 'data');

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: 'medad',
  password: 'medad',
  port: 5433,
  persistent: true,
});

async function main() {
  const cmd = process.argv[2] || 'start';
  if (cmd === 'start') {
    try {
      await pg.initialise();
      console.log('[pg] initialised');
    } catch (e) {
      console.log('[pg] initialise skipped:', e.message);
    }
    await pg.start();
    console.log('[pg] started on 5433');
    try {
      await pg.createDatabase('medad');
      console.log('[pg] database medad created');
    } catch (e) {
      console.log('[pg] createDatabase skipped:', e.message);
    }
    const client = pg.getPgClient();
    await client.connect();
    const r = await client.query('SELECT version()');
    console.log('[pg] version:', r.rows[0].version.slice(0, 60));
    await client.end();
    // keep running: stop only via "stop" command
  } else if (cmd === 'stop') {
    await pg.stop();
    console.log('[pg] stopped');
  } else if (cmd === 'status') {
    const client = pg.getPgClient();
    try {
      await client.connect();
      const r = await client.query('SELECT 1 AS ok');
      console.log('[pg] status: UP', JSON.stringify(r.rows));
      await client.end();
    } catch (e) {
      console.log('[pg] status: DOWN', e.message);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error('[pg] FATAL:', e);
  process.exit(1);
});
