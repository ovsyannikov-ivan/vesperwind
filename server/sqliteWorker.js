import fs from 'node:fs'
import { createInterface } from 'node:readline'
import { DatabaseSync, constants } from 'node:sqlite'
import { SQLITE_LIMITS, sqliteCell, quoteSqliteIdentifier as quote } from '../shared/sqlitePolicy.js'

const policies = new WeakMap()
export const openSqlite = path => {
  const file = fs.openSync(path, 'r')
  try {
    if (!fs.fstatSync(file).isFile()) throw new Error('This item is not a database file')
    const header = Buffer.alloc(16)
    if (fs.readSync(file, header, 0, 16, 0) !== 16 || !header.equals(Buffer.from('SQLite format 3\0'))) throw new Error('This file is not a SQLite 3 database')
  } finally { fs.closeSync(file) }
  // Validate without CREATE and only then open for SQL writes. No URI filenames.
  const check = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 1000 })
  try { check.prepare('SELECT name FROM sqlite_schema LIMIT 1').get() } finally { check.close() }
  const db = new DatabaseSync(path, { allowExtension: false, timeout: 1000, defensive: true })
  if (typeof db.setAuthorizer !== 'function') { db.close(); throw new Error('SQLite editing requires Node.js 24.10 or newer') }
  db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF')
  const policy = { vacuum: false }; policies.set(db, policy)
  db.setAuthorizer((action, first, second) => {
    if ((action === constants.SQLITE_ATTACH && !(first === '' && policy.vacuum)) || action === constants.SQLITE_DETACH) return constants.SQLITE_DENY
    if (action === constants.SQLITE_FUNCTION && ['load_extension', 'writefile', 'readfile'].includes(String(second).toLowerCase())) return constants.SQLITE_DENY
    if (action === constants.SQLITE_PRAGMA && ['temp_store_directory', 'data_store_directory', 'writable_schema'].includes(String(first).toLowerCase())) return constants.SQLITE_DENY
    return constants.SQLITE_OK
  })
  return db
}
const schemaSql = "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table','view') ORDER BY name COLLATE NOCASE"
export const executeSqlite = (db, request) => {
  const start = performance.now()
  if (request.action === 'schema') return { objects: db.prepare(schemaSql).all(), inTransaction: db.isTransaction }
  const object = ['data','structure'].includes(request.action) ? db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name=? AND type IN ('table','view')").get(request.table) : null
  if (['data','structure'].includes(request.action) && !object) throw new Error('The table or view no longer exists. Refresh the schema.')
  if (request.action === 'structure') return { object,
    columns: db.prepare('SELECT * FROM pragma_table_xinfo(?)').all(request.table),
    foreignKeys: db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(request.table),
    indexes: db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='index' AND tbl_name=?").all(request.table), inTransaction: db.isTransaction }
  let sql = request.action === 'data' ? `SELECT * FROM ${quote(request.table)} LIMIT 501 OFFSET ${request.offset}` : request.sql
  const results = []
  let budget = SQLITE_LIMITS.resultBytes
  while (sql.trim()) {
    // Older node:sqlite returns a finalized statement for comments alone.
    // Remove only leading trivia; SQLite still parses statements and triggers.
    sql = sql.replace(/^(?:[ \t\r\n\f]+|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))+/u, '')
    if (!sql) break
    if (results.length >= SQLITE_LIMITS.statements) throw new Error('A script may contain at most 100 statements')
    // SQLite, rather than a hand-written splitter, parses triggers and quoted semicolons.
    let statement
    try { statement = db.prepare(sql) }
    catch (error) { if (error.message === 'The SQL query contains no statements.') break; throw error }
    if (!statement.sourceSQL) break // whitespace/comments only
    sql = sql.slice(statement.sourceSQL.length)
    const columns = statement.columns().map(column => column.name)
    statement.setReadBigInts(true)
    statement.setReturnArrays(true)
    const rows = []
    let truncated = false, seen = 0
    const before = db.prepare('SELECT total_changes() AS value').get().value
    // Drain write RETURNING fully: preview bounds must never partially execute SQL.
    const policy = policies.get(db)
    policy.vacuum = /^VACUUM(?:\s+main)?\s*;?$/i.test(statement.sourceSQL.trim())
    try {
    for (const row of statement.iterate()) {
      seen++
      if (rows.length >= SQLITE_LIMITS.rows || budget <= 0) { truncated = true; continue }
      const cells = row.map(sqliteCell)
      budget -= Buffer.byteLength(JSON.stringify(cells))
      if (budget < 0) { truncated = true; continue }
      rows.push(cells)
    }
    } finally { policy.vacuum = false }
    const after = db.prepare('SELECT total_changes() AS value').get().value
    results.push({ columns, rows, truncated, changes: String(after - before), hasMore: request.action === 'data' && seen > rows.length })
  }
  return { results, elapsedMs: Math.round(performance.now() - start), inTransaction: db.isTransaction }
}
export const runSqliteWorker = () => {
  let db
  const reader = createInterface({ input: process.stdin })
  reader.on('line', line => {
    try {
      const request = JSON.parse(line)
      if (request.action === 'open') {
        db = openSqlite(request.path)
        process.stdout.write(`${JSON.stringify({ ok: true, ...executeSqlite(db, { action: 'schema' }) })}\n`)
      } else process.stdout.write(`${JSON.stringify({ ok: true, ...executeSqlite(db, request) })}\n`)
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, inTransaction: db?.isTransaction || false, error: { code: 'ESQLITE', message: error.message } })}\n`)
    }
  })
  reader.on('close', () => { db?.close(); process.exit(0) })
}
