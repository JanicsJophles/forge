import type Database from 'better-sqlite3'
import type { AgentTask } from '@forge/shared'
import { decodeTail, LOG_TAIL_BYTES } from './task-projection.js'

const TRUNCATED = '… [earlier output truncated]\n'
type StreamSnapshot = Pick<AgentTask, 'id' | 'status' | 'errorMessage' | 'log'>

// One statement keeps status, failure reason and replay consistent. Project the
// BLOB suffix in SQLite so neither the full transcript nor prompt reaches Node.
export function readTaskStreamSnapshot(
  db: Database.Database, id: string, replay = true,
): StreamSnapshot | undefined {
  // Reserve marker space within the budget so streamTask's legacy replay bound
  // does not trim the marker again. BLOB lengths also handle embedded NULs.
  const tailBytes = LOG_TAIL_BYTES - Buffer.byteLength(TRUNCATED)
  const log = replay ? `,
    CASE WHEN length(CAST(log AS BLOB)) > ${LOG_TAIL_BYTES}
      THEN substr(CAST(log AS BLOB), -${tailBytes})
      ELSE substr(CAST(log AS BLOB), 1, ${LOG_TAIL_BYTES}) END AS logTail,
    length(CAST(log AS BLOB)) > ${LOG_TAIL_BYTES} AS truncated` : ''
  const row = db.prepare(`SELECT id, status, error_message AS errorMessage${log}
    FROM tasks WHERE id = ?`).get(id) as
    | Omit<StreamSnapshot, 'log'> & { logTail?: Buffer | null; truncated?: number }
    | undefined
  if (!row) return undefined
  return {
    id: row.id, status: row.status, errorMessage: row.errorMessage,
    log: replay ? (row.truncated ? TRUNCATED : '') + decodeTail(row.logTail ?? null) : '',
  }
}
