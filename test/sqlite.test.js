import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqlite, executeSqlite } from '../server/sqliteWorker.js'
import { createFilesystemAccess } from '../server/filesystemAccess.js'
import { createSqliteSessions } from '../server/sqlite.js'
import { getDocumentHandlerForExtension } from '../src/editor/documentHandlers.js'

const fixture = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vesperwind-sqlite-'))
  const file = path.join(dir, 'test.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE "odd\"\"table" (id INTEGER PRIMARY KEY, label TEXT, payload BLOB);
    INSERT INTO "odd\"\"table" VALUES (9223372036854775807,'Привет',x'00ff');
    CREATE VIEW labels AS SELECT label FROM "odd\"\"table";`)
  db.close()
  return { dir, file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

test('SQLite extensions open a dedicated document tab', () => {
  for (const extension of ['db','sqlite','sqlite3','db3']) assert.equal(getDocumentHandlerForExtension(extension).id, 'sqlite')
})
test('SQLite validates signature and schema without creating a missing file', async () => {
  const f = await fixture()
  try {
    const fake = path.join(f.dir, 'not.db'); await fs.writeFile(fake, 'not a database')
    assert.throws(() => openSqlite(fake), /not a SQLite 3 database/)
    const malformed = path.join(f.dir, 'corrupt.db'); await fs.writeFile(malformed, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]))
    assert.throws(() => openSqlite(malformed))
    const missing = path.join(f.dir, 'missing.db'); assert.throws(() => openSqlite(missing))
    await assert.rejects(fs.stat(missing), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})
test('SQLite table data preserves 64-bit integers, blobs, null and duplicate column names', async () => {
  const f = await fixture(); const db = openSqlite(f.file)
  try {
    const response = executeSqlite(db, { action: 'data', table: 'odd"table', offset: 0 })
    assert.equal(response.results[0].rows[0][0].value, '9223372036854775807')
    assert.equal(response.results[0].rows[0][1].value, 'Привет')
    assert.equal(response.results[0].rows[0][2].value, '00ff')
    const duplicates = executeSqlite(db, { action: 'query', sql: 'SELECT 1 AS x, 2 AS x, NULL;' })
    assert.deepEqual(duplicates.results[0].columns, ['x','x','NULL'])
    assert.equal(duplicates.results[0].rows[0][2].type, 'null')
    const structure = executeSqlite(db, { action: 'structure', table: 'odd"table' })
    assert.equal(structure.columns[0].pk, 1)
    assert.equal(executeSqlite(db, { action: 'schema' }).objects[0].name, 'labels')
  } finally { db.close(); await f.cleanup() }
})
test('SQL scripts parse trigger bodies, write data/schema, and retain explicit transactions', async () => {
  const f = await fixture(); const db = openSqlite(f.file)
  try {
    const response = executeSqlite(db, { action: 'query', sql: `CREATE TABLE audit(value TEXT); CREATE TRIGGER log AFTER INSERT ON audit BEGIN UPDATE audit SET value=value||';'; END; INSERT INTO audit VALUES ('x'); SELECT * FROM audit; -- trailing comment` })
    assert.equal(response.results.length, 4)
    assert.equal(response.results[3].rows[0][0].value, 'x;')
    assert.equal(executeSqlite(db, { action: 'query', sql: "BEGIN; UPDATE audit SET value='pending'" }).inTransaction, true)
    executeSqlite(db, { action: 'query', sql: 'ROLLBACK' })
    assert.equal(db.prepare('SELECT value FROM audit').get().value, 'x;')
    executeSqlite(db, { action: 'query', sql: 'ALTER TABLE audit ADD COLUMN extra INTEGER; DELETE FROM audit; DROP TRIGGER log; VACUUM;' })
  } finally { db.close(); await f.cleanup() }
})
test('SQL preview limits do not partially execute INSERT RETURNING', async () => {
  const f = await fixture(); const db = openSqlite(f.file)
  try {
    const result = executeSqlite(db, { action: 'query', sql: 'CREATE TABLE many(x); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<700) INSERT INTO many SELECT x FROM n RETURNING x;' })
    assert.equal(result.results[1].rows.length, 500)
    assert.equal(result.results[1].truncated, true)
    assert.equal(db.prepare('SELECT count(*) AS n FROM many').get().n, 700)
    assert.equal(executeSqlite(db, { action: 'data', table: 'many', offset: 500 }).results[0].hasMore, false)
  } finally { db.close(); await f.cleanup() }
})
test('SQL accepts comment-only scripts and comments around statements without changing quoted values', async () => {
  const f = await fixture(); const db = openSqlite(f.file)
  try {
    for (const sql of ['-- comment', '/* comment */ ; -- end', '; ; /* unfinished comment', '-- first\r-- second\n/* third */']) {
      assert.deepEqual(executeSqlite(db, { action: 'query', sql }).results, [])
    }
    const result = executeSqlite(db, { action: 'query', sql: "/* first */ ; SELECT '-- literal ; /* still literal */' AS value; -- next\r\n SELECT 2; /* end */ ;" })
    assert.equal(result.results.length, 2)
    assert.equal(result.results[0].rows[0][0].value, '-- literal ; /* still literal */')
    assert.equal(result.results[1].rows[0][0].value, '2')
  } finally { db.close(); await f.cleanup() }
})
test('SQL cannot attach files, export with VACUUM INTO or load extensions', async () => {
  const f = await fixture(); const db = openSqlite(f.file)
  try {
    for (const sql of ["ATTACH ':memory:' AS other", "ATTACH '' AS other", "SELECT load_extension('missing')", "PRAGMA writable_schema=ON", `VACUUM INTO '${path.join(f.dir, 'export.db')}'`]) assert.throws(() => executeSqlite(db, { action: 'query', sql }))
    await assert.rejects(fs.stat(path.join(f.dir, 'export.db')), { code: 'ENOENT' })
  } finally { db.close(); await f.cleanup() }
})
test('Node database worker cancels CPU-bound SQL and rolls back an open transaction', async () => {
  const f = await fixture(); const access = createFilesystemAccess({ root: f.dir, desktop: false }); const sessions = createSqliteSessions({ resolve: access.resolve, verify: access.verify })
  try {
    assert.equal((await sessions.open({ sessionId: 'test', filesystemId: 'local', path: f.file })).ok, true)
    const begin = await sessions.request({ sessionId: 'test', action: 'query', sql: 'BEGIN; CREATE TABLE not_committed(x)' })
    assert.equal(begin.inTransaction, true)
    const pending = sessions.request({ sessionId: 'test', action: 'query', sql: 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n' })
    setTimeout(() => sessions.close('test'), 100)
    assert.equal((await pending).error.code, 'ECANCELLED')
    // Wait for the actual process exit and SQLite lock release.
    await new Promise(resolve => setTimeout(resolve, 100))
    const db = openSqlite(f.file)
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='not_committed'").get().n, 0)
    db.close()
  } finally { sessions.dispose(); await f.cleanup() }
})
