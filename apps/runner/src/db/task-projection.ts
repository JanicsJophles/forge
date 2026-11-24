import type Database from 'better-sqlite3'

export const LOG_TAIL_BYTES = 262144
export type TaskView = 'status' | 'detail'

// SQLite projects the byte suffix before materializing it in Node. A suffix can
// start inside a UTF-8 codepoint; omit only its leading continuation bytes.
export function decodeTail(bytes: Buffer): string {
  let start = 0
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}

export function readTaskProjection(db: Database.Database, id: string, view: TaskView) {
  const provider = (db.pragma('table_info(tasks)') as { name: string }[])
    .some(column => column.name === 'provider') ? ', provider' : ''
  const detail = view === 'detail'
    ? `, repo, branch, prompt, error_message AS errorMessage,
       substr(CAST(COALESCE(log, '') AS BLOB), -${LOG_TAIL_BYTES}) AS log_tail,
       length(CAST(COALESCE(log, '') AS BLOB)) > ${LOG_TAIL_BYTES} AS log_truncated`
    : ''
  const row = db.prepare(`SELECT id, status, created_at AS createdAt,
    started_at AS startedAt, completed_at AS completedAt, commit_sha AS commitSha
    ${provider}${detail} FROM tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  if (!row) return undefined
  if (view === 'detail') {
    row.log = decodeTail(row.log_tail as Buffer)
    row.log_truncated = Boolean(row.log_truncated)
    delete row.log_tail
  }
  return { ...row, read_projection_version: 1 }
}

/** Same last-20 ordering as /tasks, without loading prompts or logs into Node. */
export function readTaskStatusList(db: Database.Database): Record<string, unknown>[] {
  const provider = (db.pragma('table_info(tasks)') as { name: string }[])
    .some(column => column.name === 'provider') ? ', provider' : ''
  const rows = db.prepare(`SELECT id, repo, status, created_at AS createdAt,
    started_at AS startedAt, completed_at AS completedAt${provider}
    FROM tasks ORDER BY created_at DESC LIMIT 20`).all() as Record<string, unknown>[]
  return rows.map(row => ({ ...row, read_projection_version: 1 }))
}

/** List labels need a small prompt preview, never the multi-megabyte execution log. */
export function readTaskPreviewList(db: Database.Database): Record<string, unknown>[] {
  const provider = (db.pragma('table_info(tasks)') as { name: string }[])
    .some(column => column.name === 'provider') ? ', provider' : ''
  const rows = db.prepare(`SELECT id, repo, branch, status, created_at AS createdAt,
    started_at AS startedAt, completed_at AS completedAt, commit_sha AS commitSha,
    substr(prompt, 1, 256) AS prompt, length(prompt) > 256 AS prompt_truncated,
    substr(error_message, 1, 1024) AS errorMessage,
    length(COALESCE(log, '')) > 0 AS log_truncated${provider}
    FROM tasks ORDER BY created_at DESC LIMIT 20`).all() as Record<string, unknown>[]
  return rows.map(row => ({ ...row, prompt_truncated: Boolean(row.prompt_truncated),
    log_truncated: Boolean(row.log_truncated), read_projection_version: 1 }))
}
