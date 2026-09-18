try {
  const b = require('S:/SHAMEL/SHAMEL/node_modules/better-sqlite3');
  const db = b(':memory:');
  db.exec('CREATE TABLE t(a INT)');
  db.exec('INSERT INTO t VALUES (1)');
  const row = db.prepare('SELECT COUNT(*) AS n FROM t').get();
  console.log('SHAMEL-binding-ABI-OK rows=' + row.n);
} catch (e) {
  console.log('ABI-FAIL: ' + e.message);
}
