// ---------------------------------------------------------------------------
// board-sync: keep forge-task-<id> agent-board entries honest.
// ---------------------------------------------------------------------------
// Dispatchers register `forge-task-<id>` on the board with status 'running'
// and a multi-hour TTL, but nothing ever told the board when the task ended,
// so finished tasks stayed "running" until the TTL lapsed. Two defences:
//
//   settleBoardEntry  - called from the single task-status choke point
//                       (updateTaskStatus) on every terminal transition.
//   reconcileBoard    - sweeps every forge-task-* entry against the tasks
//                       table (startup, periodic, and on board reads) so
//                       entries missed by a crash or a restart self-heal.
//
// Raw SQL on purpose: this module must not import db/queries.ts (cycle).
// ---------------------------------------------------------------------------

import { db } from './schema.js'

export const BOARD_TASK_PREFIX = 'forge-task-'

/** Task end states. Anything here is never "live" on the board. */
export const TERMINAL_STATUSES = [
  'completed', 'failed', 'verified', 'unverified', 'capped', 'killed',
] as const

const TERMINAL = new Set<string>(TERMINAL_STATUSES)

/** Board status written for an entry whose task row no longer exists. */
export const MISSING_STATUS = 'missing'

/** A missing task only retires an entry older than this (dispatch race guard). */
const MISSING_GRACE_SECONDS = 600

export function isTerminalStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && TERMINAL.has(status)
}

export function boardAgentId(taskId: string): string {
  return `${BOARD_TASK_PREFIX}${taskId}`
}

/**
 * Write the final status onto a task's board entry, expire it so it leaves
 * liveAgents, and emit a task_<status> event. Returns true when it changed
 * the entry. No-op when the task never registered on the board, or when the
 * entry is already retired with this exact status (idempotent).
 *
 * Write-only statements (no SELECT) on purpose: this runs inside the cancel
 * path, whose projection tests bar extra reads.
 */
export function settleBoardEntry(taskId: string, status: string): boolean {
  const params = { id: boardAgentId(taskId), status, taskId }
  const pending = "agent_id = @id AND (status IS NOT @status OR expires_at > datetime('now'))"
  return db.transaction(() => {
    db.prepare(`
      INSERT INTO agent_events (event_type, repo, ticket, agent_id, details)
      SELECT 'task_' || @status, repo, ticket, agent_id,
             json_object('taskId', @taskId, 'previousStatus', status)
      FROM agent_state WHERE ${pending}
    `).run(params)
    const info = db.prepare(`
      UPDATE agent_state
      SET status = @status, expires_at = datetime('now', '-1 seconds'), updated_at = datetime('now')
      WHERE ${pending}
    `).run(params)
    return info.changes > 0
  })()
}

/**
 * Reconcile every forge-task-* entry against the tasks table. Terminal tasks
 * settle with their real final status; missing tasks settle as 'missing' once
 * past the grace window. Active tasks are left alone. Returns entries changed.
 */
export function reconcileBoard(): number {
  const rows = db.prepare(`
    SELECT a.agent_id AS agent_id, t.status AS task_status, t.id AS task_id,
           (a.updated_at <= datetime('now', '-${MISSING_GRACE_SECONDS} seconds')) AS aged
    FROM agent_state a
    LEFT JOIN tasks t ON a.agent_id = '${BOARD_TASK_PREFIX}' || t.id
    WHERE a.agent_id LIKE '${BOARD_TASK_PREFIX}%'
  `).all() as Array<{ agent_id: string; task_status: string | null; task_id: string | null; aged: number }>

  let changed = 0
  for (const r of rows) {
    const taskId = r.agent_id.slice(BOARD_TASK_PREFIX.length)
    if (r.task_id === null) {
      if (r.aged && settleBoardEntry(taskId, MISSING_STATUS)) changed++
    } else if (isTerminalStatus(r.task_status)) {
      if (settleBoardEntry(taskId, r.task_status as string)) changed++
    }
  }
  return changed
}

/** Run reconcileBoard on an interval; failures are logged, never thrown. */
export function startBoardReconciler(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  const run = (): void => {
    try {
      const n = reconcileBoard()
      if (n > 0) console.log(`[board] reconciled ${n} stale forge-task entries`)
    } catch (err) {
      console.error('[board] reconcile failed', err)
    }
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return timer
}
