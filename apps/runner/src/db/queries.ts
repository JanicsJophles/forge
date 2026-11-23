import { db } from './schema.js'
import type { AgentTask, TaskStatus } from '@forge/shared'
import { decodeTail } from './task-projection.js'

// The GET /tasks list caps each task's log to this many trailing bytes. A single
// 1.28 MB codex log overran Atlas's 1 MB relay frame; 20 tasks x this cap keeps
// the whole list well under that limit. GET /tasks/:id still returns the full log.
export const LIST_LOG_TAIL_BYTES = 4000

interface TaskRow {
  provider: 'claude' | 'codex'
  auto_commit: number | null
  read_only: number | null
  id: string
  repo: string
  branch: string
  prompt: string
  status: string
  log: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  error_message: string | null
  commit_sha: string | null
}

function rowToTask(row: TaskRow): AgentTask {
  return {
    provider: row.provider,
    autoCommit: row.auto_commit == null ? undefined : Boolean(row.auto_commit),
    readOnly: row.read_only == null ? undefined : Boolean(row.read_only),
    id: row.id,
    repo: row.repo,
    branch: row.branch,
    prompt: row.prompt,
    status: row.status as TaskStatus,
    log: row.log,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    errorMessage: row.error_message ?? undefined,
    commitSha: row.commit_sha ?? undefined,
  }
}

export function insertTask(task: AgentTask): void {
  db.prepare(`
    INSERT INTO tasks (id, repo, branch, prompt, status, log, created_at, provider, auto_commit, read_only)
    VALUES (@id, @repo, @branch, @prompt, @status, @log, @createdAt, @provider, @autoCommit, @readOnly)
  `).run({
    id: task.id,
    provider: task.provider ?? 'claude',
    autoCommit: task.autoCommit == null ? null : Number(task.autoCommit),
    readOnly: task.readOnly == null ? null : Number(task.readOnly),
    repo: task.repo,
    branch: task.branch,
    prompt: task.prompt,
    status: task.status,
    log: task.log,
    createdAt: task.createdAt,
  })
}

export function getTask(id: string): AgentTask | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  return row ? rowToTask(row) : undefined
}

// A listed task is a regular AgentTask, plus a `log_truncated` flag set when the
// row's log was capped to its trailing bytes (so callers know the log is partial).
export type ListedTask = AgentTask & { log_truncated?: boolean }

// logTailBytes caps each row's log to its trailing N bytes (UTF-8 safe) so a
// large transcript does not bloat the list response. Omit it for the full log.
export function listTasks(limit = 20, logTailBytes?: number): ListedTask[] {
  if (logTailBytes === undefined) {
    const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as TaskRow[]
    return rows.map(rowToTask)
  }
  const rows = db.prepare(
    `SELECT id, repo, branch, prompt, status, created_at, started_at, completed_at,
            error_message, commit_sha, provider, auto_commit, read_only,
            substr(CAST(COALESCE(log, '') AS BLOB), ?) AS log,
            length(CAST(COALESCE(log, '') AS BLOB)) > ? AS log_truncated
     FROM tasks ORDER BY created_at DESC LIMIT ?`
  ).all(-logTailBytes, logTailBytes, limit) as (Omit<TaskRow, 'log'> & {
    log: Buffer | string | null
    log_truncated: number
  })[]
  // substr() of an empty blob yields SQL NULL; treat it as an empty log.
  return rows.map(({ log, log_truncated, ...rest }) => {
    const task: ListedTask = rowToTask({ ...rest, log: log == null ? '' : typeof log === 'string' ? log : decodeTail(log) })
    if (log_truncated) task.log_truncated = true
    return task
  })
}

export function updateTaskStatus(id: string, status: TaskStatus): void {
  if (status === 'running') {
    db.prepare(`UPDATE tasks SET status = ?, started_at = datetime('now') WHERE id = ?`).run(status, id)
  } else if (status === 'completed' || status === 'failed') {
    db.prepare(`UPDATE tasks SET status = ?, completed_at = datetime('now') WHERE id = ?`).run(status, id)
  } else {
    db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, id)
  }
}

export function appendLog(id: string, chunk: string): void {
  db.prepare(`UPDATE tasks SET log = log || ? WHERE id = ?`).run(chunk, id)
}

export function setErrorMessage(id: string, message: string): void {
  db.prepare(`UPDATE tasks SET error_message = ? WHERE id = ?`).run(message, id)
}

export function setCommitSha(id: string, sha: string): void {
  db.prepare(`UPDATE tasks SET commit_sha = ? WHERE id = ?`).run(sha, id)
}

export function countActiveTasks(): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM tasks WHERE status IN ('queued', 'running')`
  ).get() as { count: number }
  return row.count
}
