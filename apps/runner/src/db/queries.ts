import { db } from './schema.js'
import { decodeHead, decodeTail } from './task-projection.js'
import type { AgentTask, TaskStatus } from '@forge/shared'

// List views return only a trailing tail of each task's log so GET /tasks
// doesn't ship up to 20 full transcripts at once. The single-task detail view
// still returns the full log (getTask).
export const LIST_LOG_TAIL_BYTES = 8192

// List views also bound each task's prompt to a leading head. Prompts are accepted
// up to the 2mb JSON body limit, so an unbounded list could balloon to tens of MB
// and echo full prompt text in a summary view. The single-task reads (getTask /
// the detail projection) still return the complete prompt.
export const LIST_PROMPT_MAX_BYTES = 4096

interface TaskRow {
  provider: 'claude' | 'codex'
  auto_commit: number | null
  model: string | null
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
    model: row.model ?? undefined,
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
    INSERT INTO tasks (id, repo, branch, prompt, status, log, created_at, provider, auto_commit, model)
    VALUES (@id, @repo, @branch, @prompt, @status, @log, @createdAt, @provider, @autoCommit, @model)
  `).run({
    id: task.id,
    provider: task.provider ?? 'claude',
    autoCommit: task.autoCommit == null ? null : Number(task.autoCommit),
    model: task.model ?? null,
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

interface TaskListRow extends Omit<TaskRow, 'log' | 'prompt'> {
  prompt_head: Buffer | null
  prompt_bytes: number
  log_tail: Buffer
  log_bytes: number
}

function listRowToTask(row: TaskListRow): AgentTask {
  return {
    provider: row.provider,
    autoCommit: row.auto_commit == null ? undefined : Boolean(row.auto_commit),
    model: row.model ?? undefined,
    id: row.id,
    repo: row.repo,
    branch: row.branch,
    prompt: decodeHead(row.prompt_head),
    promptBytes: row.prompt_bytes,
    promptTruncated: row.prompt_bytes > LIST_PROMPT_MAX_BYTES,
    status: row.status as TaskStatus,
    log: decodeTail(row.log_tail),
    logBytes: row.log_bytes,
    logTruncated: row.log_bytes > LIST_LOG_TAIL_BYTES,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    errorMessage: row.error_message ?? undefined,
    commitSha: row.commit_sha ?? undefined,
  }
}

// Normalize SQLite UTC and ISO timestamps only for sorting; retain the stored text.
// rowid makes equal instants deterministic, with later insertions first.
const TASK_NEWEST_FIRST = 'julianday(created_at) DESC, rowid DESC'

export interface TaskHistoryFilters {
  repo?: string
  status?: TaskStatus
  before?: string
}

export function listTasks(limit = 20, filters: TaskHistoryFilters = {}): AgentTask[] {
  const conditions: string[] = []
  const parameters: (string | number)[] = []
  if (filters.repo !== undefined) {
    conditions.push('repo = ?')
    parameters.push(filters.repo)
  }
  if (filters.status !== undefined) {
    conditions.push('status = ?')
    parameters.push(filters.status)
  }
  if (filters.before !== undefined) {
    conditions.push(`(julianday(created_at), rowid) <
      (SELECT julianday(created_at), rowid FROM tasks WHERE id = ?)`)
    parameters.push(filters.before)
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const rows = db.prepare(`
    SELECT id, repo, branch, status, created_at, started_at, completed_at,
           error_message, commit_sha, provider, auto_commit, model,
           substr(CAST(COALESCE(prompt, '') AS BLOB), 1, ${LIST_PROMPT_MAX_BYTES}) AS prompt_head,
           length(CAST(COALESCE(prompt, '') AS BLOB)) AS prompt_bytes,
           substr(CAST(COALESCE(log, '') AS BLOB), -${LIST_LOG_TAIL_BYTES}) AS log_tail,
           length(CAST(COALESCE(log, '') AS BLOB)) AS log_bytes
    FROM tasks ${where} ORDER BY ${TASK_NEWEST_FIRST} LIMIT ?
  `).all(...parameters, limit) as TaskListRow[]
  return rows.map(listRowToTask)
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

/**
 * Age in whole seconds of the longest-running task — floor(now - MIN(normalized started_at))
 * over tasks with status='running' — or null when no running timestamp is usable. Used by
 * GET /health as an early warning that a task is approaching the SIGTERM timeout.
 * A single self-contained read; any failure degrades to null rather than throwing.
 */
export function oldestRunningTaskAgeSeconds(): number | null {
  try {
    const row = db.prepare(
      `SELECT (julianday('now') - MIN(julianday(started_at))) * 86400 AS age
         FROM tasks WHERE status = 'running' AND started_at IS NOT NULL`
    ).get() as { age: number | null } | undefined
    if (!row || row.age == null) return null
    return Math.max(0, Math.floor(row.age))
  } catch {
    return null
  }
}

export function appendLog(id: string, chunk: string): void {
  db.prepare(`UPDATE tasks SET log = COALESCE(log, '') || ? WHERE id = ?`).run(chunk, id)
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

/**
 * A privacy-safe summary of a queued/running task for the /agent-context
 * coordination surface. Deliberately excludes the full prompt and the log —
 * only a truncated prompt snippet is exposed so agents can see what is
 * already running in a repo without leaking task contents.
 */
export interface LiveTaskSummary {
  id: string
  repo: string
  branch: string
  status: TaskStatus
  provider: 'claude' | 'codex'
  createdAt: string
  promptSnippet: string
}

const PROMPT_SNIPPET_MAX = 120
export const ACTIVE_PROMPT_MAX_BYTES = 4096

export function listActiveTasks(): LiveTaskSummary[] {
  const rows = db.prepare(
    `SELECT id, repo, branch, status, provider, created_at,
            substr(CAST(prompt AS BLOB), 1, ${ACTIVE_PROMPT_MAX_BYTES}) AS prompt_head,
            length(CAST(prompt AS BLOB)) AS prompt_bytes
       FROM tasks
      WHERE status IN ('queued', 'running')
      ORDER BY ${TASK_NEWEST_FIRST}`
  ).all() as Array<Pick<TaskRow, 'id' | 'repo' | 'branch' | 'status' | 'provider' | 'created_at'> & { prompt_head: Buffer | null; prompt_bytes: number }>

  return rows.map(row => {
    const flat = decodeHead(row.prompt_head).replace(/\s+/g, ' ').trim()
    // Uninspected bytes may contain meaningful text even after an all-space head.
    const truncated = row.prompt_bytes > ACTIVE_PROMPT_MAX_BYTES || flat.length > PROMPT_SNIPPET_MAX
    // Avoid slicing a supplementary Unicode character between its surrogates.
    const head = flat.slice(0, PROMPT_SNIPPET_MAX - 1).replace(/[\uD800-\uDBFF]$/, '')
    const promptSnippet = truncated
      ? head + '\u2026'
      : flat
    return {
      id: row.id,
      repo: row.repo,
      branch: row.branch,
      status: row.status as TaskStatus,
      provider: row.provider,
      createdAt: row.created_at,
      promptSnippet,
    }
  })
}
