import type Database from 'better-sqlite3'

export const LOG_TAIL_BYTES = 262144
export type TaskView = 'status' | 'detail'

// SQLite projects the byte suffix before materializing it in Node. A suffix can
// start inside a UTF-8 codepoint; omit only its leading continuation bytes.
function tailStart(bytes: Buffer | null): number {
  // SQLite substr of an empty BLOB returns NULL, including COALESCE(log, '').
  if (bytes === null) return 0
  let start = 0
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return start
}

export function decodeTail(bytes: Buffer | null): string {
  return bytes?.subarray(tailStart(bytes)).toString('utf8') ?? ''
}

export function readTaskProjection(db: Database.Database, id: string, view: TaskView) {
  const columns = db.pragma('table_info(tasks)') as { name: string }[]
  const provider = columns.some(column => column.name === 'provider') ? ', provider' : ''
  const autoCommit = columns.some(column => column.name === 'auto_commit')
    ? ', auto_commit AS autoCommit' : ''
  const detail = view === 'detail'
    ? `, repo, branch, prompt,
       substr(CAST(COALESCE(log, '') AS BLOB), -${LOG_TAIL_BYTES}) AS log_tail,
       length(CAST(COALESCE(log, '') AS BLOB)) AS logBytes,
       length(CAST(COALESCE(log, '') AS BLOB)) > ${LOG_TAIL_BYTES} AS log_truncated`
    : ''
  // durationMs is derived from the stored SQLite datetime strings via julianday
  // (days) scaled to ms: finished tasks measure completed_at - started_at, running
  // tasks measure now - started_at, and still-queued tasks (no started_at) are null.
  // Clamp to 0 so clock skew never yields a negative elapsed time.
  const duration = `CASE WHEN started_at IS NULL THEN NULL ELSE
    MAX(0, CAST(ROUND((julianday(COALESCE(completed_at, 'now'))
      - julianday(started_at)) * 86400000.0) AS INTEGER)) END AS durationMs`
  const row = db.prepare(`SELECT id, status, created_at AS createdAt,
    started_at AS startedAt, completed_at AS completedAt, commit_sha AS commitSha,
    error_message AS errorMessage, ${duration}
    ${provider}${autoCommit}${detail} FROM tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  if (!row) return undefined
  row.autoCommit = row.autoCommit == null ? undefined : Boolean(row.autoCommit)
  if (view === 'detail') {
    const tail = row.log_tail as Buffer | null
    // logBytes is the complete UTF-8 BLOB length (including embedded NULs).
    // logTailOffset is the zero-based byte position of the first complete
    // codepoint returned in log, after skipping any continuation bytes.
    row.logTailOffset = Math.max(0, (row.logBytes as number) - LOG_TAIL_BYTES) + tailStart(tail)
    row.log = decodeTail(tail)
    row.log_truncated = Boolean(row.log_truncated)
    delete row.log_tail
  }
  return { ...row, read_projection_version: 1 }
}
