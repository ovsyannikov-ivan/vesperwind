// Bounds apply to rendered previews; SQL still runs to completion (including RETURNING).
export const SQLITE_LIMITS = Object.freeze({ rows: 500, cellBytes: 4096, resultBytes: 4 * 1024 * 1024, sqlBytes: 1024 * 1024, statements: 100, timeoutMs: 30_000 })
export const quoteSqliteIdentifier = value => `"${String(value).replaceAll('"', '""')}"`
export const validateSqliteRequest = request => {
  if (!request || typeof request.sessionId !== 'string' || !/^[\w-]{1,128}$/.test(request.sessionId)) return 'Invalid database session'
  if (!['schema', 'structure', 'data', 'query'].includes(request.action)) return 'Unknown database action'
  if (request.action === 'query' && (typeof request.sql !== 'string' || !request.sql.trim() || new TextEncoder().encode(request.sql).length > SQLITE_LIMITS.sqlBytes || request.sql.includes('\0'))) return 'SQL must contain between 1 byte and 1 MiB, without NUL characters'
  if (['structure', 'data'].includes(request.action) && (typeof request.table !== 'string' || !request.table || request.table.length > 1024)) return 'Choose a table or view'
  if (request.action === 'data' && (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 1_000_000_000)) return 'Invalid page offset'
  return null
}
export const sqliteCell = value => {
  if (value === null) return { type: 'null', value: null }
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() }
  if (typeof value === 'number') return { type: 'real', value: String(value) }
  if (value instanceof Uint8Array) return { type: 'blob', value: Buffer.from(value.subarray(0, 64)).toString('hex'), bytes: value.length, truncated: value.length > 64 }
  const text = String(value)
  return { type: 'text', value: text.slice(0, SQLITE_LIMITS.cellBytes), truncated: text.length > SQLITE_LIMITS.cellBytes }
}
