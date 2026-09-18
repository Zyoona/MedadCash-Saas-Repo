try {
  const b = require('better-sqlite3');
  const db = b(':memory:');
  db.exec('CREATE TABLE t(a INT)');
  db.exec('INSERT INTO t VALUES (7)');
  const row = db.prepare('SELECT COUNT(*) AS n FROM t').get();
  console.log('LOCAL-better-sqlite3-OK rows=' + row.n);
} catch (e) {
  console.log('LOCAL-FAIL: ' + e.message);
  process.exit(1);
}
