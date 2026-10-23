import { db } from './schema.js'
import type { AgentTask, TaskStatus } from '@forge/shared'

interface TaskRow {
  provider: 'claude' | 'codex'
  auto_commit: number | null
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
    INSERT INTO tasks (id, repo, branch, prompt, status, log, created_at, provider, auto_commit)
    VALUES (@id, @repo, @branch, @prompt, @status, @log, @createdAt, @provider, @autoCommit)
  `).run({
    id: task.id,
    provider: task.provider ?? 'claude',
    autoCommit: task.autoCommit == null ? null : Number(task.autoCommit),
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

export function listTasks(limit = 20): AgentTask[] {
  const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as TaskRow[]
  return rows.map(rowToTask)
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

export function setTaskChanges(id: string, changes: unknown): void {
  db.prepare(`UPDATE tasks SET changes = ? WHERE id = ?`).run(JSON.stringify(changes), id)
}

export function getTaskChanges(id: string): { status: TaskStatus; changes: Record<string, unknown> | null } | undefined {
  const row = db.prepare('SELECT status, changes FROM tasks WHERE id = ?').get(id) as { status: string; changes: string | null } | undefined
  if (!row) return undefined
  return { status: row.status as TaskStatus, changes: row.changes ? JSON.parse(row.changes) : null }
}

export function countActiveTasks(): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM tasks WHERE status IN ('queued', 'running')`
  ).get() as { count: number }
  return row.count
}
