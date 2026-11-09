import type Database from 'better-sqlite3'

export const MAX_LOG_SLICE_BYTES = 262144

// Project only the requested bytes into Node, using one SQLite snapshot for
// the slice and its total. BLOB offsets preserve embedded NULs and UTF-8 bytes.
export function readTaskLog(db: Database.Database, id: string, offset: number, limit: number) {
  // Guard EOF before substr: SQLite narrows substring positions to 32 bits.
  const row = db.prepare(`SELECT
    CASE WHEN ? >= length(CAST(COALESCE(log, '') AS BLOB)) THEN NULL
      ELSE substr(CAST(COALESCE(log, '') AS BLOB), ?, ?) END AS bytes,
    length(CAST(COALESCE(log, '') AS BLOB)) AS totalBytes
    FROM tasks WHERE id = ?`).get(BigInt(offset), BigInt(offset) + 1n, limit, id) as
    { bytes: Buffer | null; totalBytes: number } | undefined
  if (!row) return undefined
  const bytes = row.bytes ?? Buffer.alloc(0)
  // Return the raw bytes; callers choose base64 (JSON) or send the Buffer as-is
  // (text) so embedded NULs and UTF-8 sequences are never re-encoded.
  return { bytes, offset, nextOffset: offset + bytes.length, totalBytes: row.totalBytes }
}

// Return the last `lines` newline-delimited lines of the task's log, scanning
// backward from the end. A trailing newline terminates the final line (it is
// not treated as introducing an empty trailing line); a log with no trailing
// newline still yields its final line. Fewer than `lines` lines returns the
// whole log. The full blob is read because an accurate line tail must scan from
// the end; the result shares readTaskLog's shape so the route sends it the same
// way. Returns undefined when the task does not exist.
export function readTaskLogTail(db: Database.Database, id: string, lines: number) {
  const row = db.prepare(`SELECT CAST(COALESCE(log, '') AS BLOB) AS bytes,
    length(CAST(COALESCE(log, '') AS BLOB)) AS totalBytes
    FROM tasks WHERE id = ?`).get(id) as
    { bytes: Buffer | null; totalBytes: number } | undefined
  if (!row) return undefined
  const full = row.bytes ?? Buffer.alloc(0)
  let start = 0
  if (full.length > 0) {
    // Skip the final terminating newline so it does not count as a separator.
    let index = full.length - 1
    if (full[index] === 0x0a) index--
    let seen = 0
    for (; index >= 0; index--) {
      if (full[index] === 0x0a && ++seen === lines) {
        start = index + 1
        break
      }
    }
  }
  const bytes = full.subarray(start)
  return { bytes, offset: start, nextOffset: full.length, totalBytes: row.totalBytes }
}
