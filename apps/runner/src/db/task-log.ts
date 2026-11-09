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

// Read a task's status and stored error message for the X-Task-Status /
// X-Task-Error headers. A single narrow read (no log blob) so a tailing client
// can tell when the task is terminal and, if it failed, why — without a second
// request. Returns undefined when the task does not exist (so the caller keeps
// 404); status is '' when the row exists but status is NULL; errorMessage is
// null unless a message is stored.
export function readTaskStatusMeta(
  db: Database.Database,
  id: string,
): { status: string; errorMessage: string | null } | undefined {
  const row = db.prepare('SELECT status, error_message AS errorMessage FROM tasks WHERE id = ?').get(id) as
    { status: string | null; errorMessage: string | null } | undefined
  if (!row) return undefined
  return { status: row.status ?? '', errorMessage: row.errorMessage ?? null }
}

// Scan backward in bounded BLOB slices, keeping at most MAX_LOG_SLICE_BYTES.
// A terminating newline belongs to the final line. If the byte cap truncates
// a line, offset exposes the omitted prefix. One snapshot keeps all slices and
// totalBytes consistent while other connections append to the transcript.
export function readTaskLogTail(db: Database.Database, id: string, lines: number) {
  return db.transaction(() => {
    const row = db.prepare(`SELECT length(CAST(COALESCE(log, '') AS BLOB)) AS totalBytes
      FROM tasks WHERE id = ?`).get(id) as { totalBytes: number } | undefined
    if (!row) return undefined
    const { totalBytes } = row
    const floor = Math.max(0, totalBytes - MAX_LOG_SLICE_BYTES)
    const slice = db.prepare(`SELECT substr(CAST(COALESCE(log, '') AS BLOB), ?, ?) AS bytes
      FROM tasks WHERE id = ?`)
    const chunks: Buffer[] = []
    let cursor = totalBytes
    let seen = 0
    while (cursor > floor) {
      const start = Math.max(floor, cursor - 16384)
      const { bytes } = slice.get(BigInt(start) + 1n, cursor - start, id) as { bytes: Buffer }
      for (let index = bytes.length - 1; index >= 0; index--) {
        // Ignore only the final newline, including when a chunk ends in one.
        if (start + index === totalBytes - 1 && bytes[index] === 0x0a) continue
        if (bytes[index] === 0x0a && ++seen === lines) {
          chunks.push(bytes.subarray(index + 1))
          const offset = start + index + 1
          return { bytes: Buffer.concat(chunks.reverse()), offset, nextOffset: totalBytes, totalBytes }
        }
      }
      chunks.push(bytes)
      cursor = start
    }
    return { bytes: Buffer.concat(chunks.reverse()), offset: floor, nextOffset: totalBytes, totalBytes }
  })()
}
