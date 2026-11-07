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
