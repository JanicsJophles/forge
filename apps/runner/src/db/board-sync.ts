// ---------------------------------------------------------------------------
// board-sync: keep forge-task-<id> agent-board entries honest.
// ---------------------------------------------------------------------------
// Dispatchers register `forge-task-<id>` on the board with status 'running'
// and a multi-hour TTL, but nothing ever told the board when the task ended,
// so finished tasks stayed "running" until the TTL lapsed. Two defences:
//
//   settleBoardEntry  - called from the single task-status choke point
//                       (updateTaskStatus) on every terminal transition.
//   reconcileBoard    - sweeps open forge-task-* entries against the tasks
//                       table (startup, periodic, and on board reads) so
//                       entries missed by a crash or a restart self-heal.
//
// Raw SQL on purpose: this module must not import db/queries.ts (cycle).
// Importing agent-state.js guarantees the board tables exist first.
// ---------------------------------------------------------------------------

import { db } from './schema.js'
import { TERMINAL_BOARD_STATUSES, TERMINAL_BOARD_STATUSES_SQL } from './agent-state.js'

export const BOARD_TASK_PREFIX = 'forge-task-'

/** Board status written for an entry whose task row no longer exists. */
export const MISSING_STATUS = 'missing'

/** A missing task only retires an entry older than this (dispatch race guard). */
const MISSING_GRACE_SECONDS = 600

/** Catch-up sweeps only announce tasks that ended this recently. */
const EVENT_REPLAY_SECONDS = 900

const TERMINAL = new Set<string>(TERMINAL_BOARD_STATUSES)

export function isTerminalStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && TERMINAL.has(status)
}

export function boardAgentId(taskId: string): string {
  return `${BOARD_TASK_PREFIX}${taskId}`
}

/**
 * Write the final status onto a task's board entry, expire it so it leaves
 * liveAgents, and (unless emitEvent is false) append a task_<status> event.
 * Returns true when it changed the entry.
 *
 * No-op when the task never registered on the board, or when the entry
 * already carries a terminal status. That makes it idempotent and keeps a
 * richer client verdict such as `verified` from being overwritten.
 * Write-only statements, one transaction.
 */
export function settleBoardEntry(taskId: string, status: string, emitEvent = true): boolean {
  const params = { id: boardAgentId(taskId), status, taskId }
  const open = `agent_id = @id AND COALESCE(status, '') NOT IN (${TERMINAL_BOARD_STATUSES_SQL})`
  return db.transaction(() => {
    if (emitEvent) {
      db.prepare(`
        INSERT INTO agent_events (event_type, repo, ticket, agent_id, details)
        SELECT 'task_' || @status, repo, ticket, agent_id,
               json_object('taskId', @taskId, 'previousStatus', status)
        FROM agent_state WHERE ${open}
      `).run(params)
    }
    const info = db.prepare(`
      UPDATE agent_state
      SET status = @status,
          expires_at = MIN(expires_at, datetime('now', '-1 seconds')),
          updated_at = datetime('now')
      WHERE ${open}
    `).run({ id: params.id, status })
    return info.changes > 0
  })()
}

interface OpenEntryRow {
  agent_id: string
  task_id: string | null
  task_status: string | null
  aged: number
  recent: number | null
}

/**
 * Reconcile every open forge-task-* entry against the tasks table. Terminal
 * tasks settle with their real final status; missing tasks settle as
 * 'missing' once past the grace window. Active tasks are left alone.
 * Returns the number of entries changed.
 *
 * The join goes through the tasks primary key (substr, not string concat on
 * the tasks side), so a sweep is one index lookup per open entry and never
 * scans the large tasks table. Old ghosts settle silently: an event is only
 * written for a task that ended inside the replay window.
 */
export function reconcileBoard(): number {
  const prefixLen = BOARD_TASK_PREFIX.length
  const rows = db.prepare(`
    SELECT a.agent_id AS agent_id, t.id AS task_id, t.status AS task_status,
           (a.updated_at <= datetime('now', '-${MISSING_GRACE_SECONDS} seconds')) AS aged,
           (t.completed_at >= datetime('now', '-${EVENT_REPLAY_SECONDS} seconds')) AS recent
    FROM agent_state a
    LEFT JOIN tasks t ON t.id = substr(a.agent_id, ${prefixLen + 1})
    WHERE substr(a.agent_id, 1, ${prefixLen}) = '${BOARD_TASK_PREFIX}'
      AND COALESCE(a.status, '') NOT IN (${TERMINAL_BOARD_STATUSES_SQL})
  `).all() as OpenEntryRow[]

  let changed = 0
  for (const r of rows) {
    const taskId = r.agent_id.slice(prefixLen)
    if (r.task_id === null) {
      if (r.aged && settleBoardEntry(taskId, MISSING_STATUS, false)) changed++
    } else if (isTerminalStatus(r.task_status)) {
      if (settleBoardEntry(taskId, r.task_status as string, Boolean(r.recent))) changed++
    }
  }
  return changed
}

/** Run reconcileBoard now and on an interval; failures are logged, never thrown. */
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
