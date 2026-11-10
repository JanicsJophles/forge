import { realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import type { AgentProvider, AgentTask, RunRequest, TaskStatus } from '@forge/shared'
import { config, isRepoAllowed } from '../config.js'
import {
  insertTask,
  getTask,
  listTasks,
  countActiveTasks,
  listActiveTasks,
  updateTaskStatus,
  setErrorMessage,
} from '../db/queries.js'
import { createEmitter, getEmitter } from '../agent/stream.js'
import { runTask, killTask } from '../agent/runner.js'
import { getCurrentBranch } from '../agent/git.js'
import { getChangedFiles, summarizeChangedFiles, boundChangedFiles, getChangesPatch } from '../agent/git-changes.js'
import { freeDiskBytes } from '../agent/disk.js'
import { db } from '../db/schema.js'
import { readTaskProjection } from '../db/task-projection.js'
import { capabilitiesRouter } from './capabilities.js'

import { streamTask } from './task-stream.js'
import { readTaskStreamSnapshot } from '../db/task-stream-snapshot.js'

// A worktree's top level is its lock identity; the shared Git common-dir is
// deliberately unsuitable because linked worktrees can run independently.
function checkoutRoot(directory: string): string {
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) {
    delete env[key]
  }
  return realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, env,
  }).trim())
}

// Stored paths can be legacy subdirectories or aliases changed since dispatch.
// Resolve them with the same rules as new submissions before shared admission.
function resolveCheckout(storedPath: string):
  | { ok: true; repo: string }
  | { ok: false; status: number; body: Record<string, unknown> } {
  if (!isRepoAllowed(storedPath)) {
    return { ok: false, status: 400, body: { error: 'repo path is not in ALLOWED_REPO_PATHS' } }
  }

  let repo: string
  try {
    repo = realpathSync(storedPath)
    if (!statSync(repo).isDirectory()) throw new Error('not a directory')
  } catch {
    return { ok: false, status: 400, body: { error: 'repo must be an existing directory' } }
  }
  if (!isRepoAllowed(repo)) {
    return { ok: false, status: 400, body: { error: 'repo path is not in ALLOWED_REPO_PATHS' } }
  }

  try {
    repo = checkoutRoot(repo)
  } catch {
    return { ok: false, status: 400, body: { error: 'repo must be inside a Git checkout with a discoverable root' } }
  }

  return { ok: true, repo }
}

// Shared admission guards for dispatching work into a checkout. `repo` must be a
// canonical checkout root — the POST / body path resolves one from untrusted
// input; retries resolve the stored path again before admission.
// `requestedBranch`, when present, is an already-validated non-empty string.
// Factoring these into one place means the retry endpoint cannot bypass the
// allowlist re-check, the active-checkout conflict, the disk guard, the
// concurrency limit, or branch resolution that POST / enforces.
type AdmissionOutcome =
  | { ok: true; branch: string }
  | { ok: false; status: number; body: Record<string, unknown> }

function admitCheckout(repo: string, requestedBranch: string | undefined): AdmissionOutcome {
  if (!isRepoAllowed(repo)) {
    return { ok: false, status: 400, body: { error: 'repo checkout root is not in ALLOWED_REPO_PATHS' } }
  }

  // Keep admission synchronous: queued login probes also own their checkout.
  // Resolve older rows too, since they may contain aliases.
  const conflict = listActiveTasks().find(task => {
    let activeRepo: string
    try { activeRepo = checkoutRoot(task.repo) }
    catch {
      try { activeRepo = realpathSync(task.repo) }
      catch { activeRepo = resolve(task.repo) }
    }
    return activeRepo === repo
  })
  if (conflict) {
    return { ok: false, status: 409, body: { error: 'repo checkout already has an active task', taskId: conflict.id } }
  }

  // Disk guard: the runner git-pulls into the repo and the agent writes files
  // there plus a growing SQLite WAL. If the disk fills, git and the agent
  // corrupt state, so refuse new work below MIN_FREE_DISK_MB. Fail open if we
  // cannot read the filesystem — never crash the request over a stat error.
  const minFreeBytes = config.minFreeDiskMb * 1024 * 1024
  for (const volume of ['repo', 'data'] as const) {
    try {
      // Resolve the open database itself so a symlinked forge.db checks the
      // filesystem that actually stores SQLite and its adjacent WAL.
      const directory = volume === 'repo' ? repo : dirname(realpathSync(db.name))
      const freeBytes = freeDiskBytes(directory)
      if (freeBytes < minFreeBytes) {
        return {
          ok: false,
          status: 507,
          body: {
            error: 'insufficient disk space to accept new tasks',
            volume,
            freeMb: Math.floor(freeBytes / (1024 * 1024)),
            requiredMb: config.minFreeDiskMb,
          },
        }
      }
    } catch (err: any) {
      console.warn(`[runner] ${volume} disk-space check failed, measurement unknown: ${err.message}`)
    }
  }

  if (countActiveTasks() >= config.maxConcurrentTasks) {
    return { ok: false, status: 429, body: { error: 'max concurrent tasks reached' } }
  }

  // Validate the branch claim against the checkout so two callers cannot race the
  // same working tree under mismatched branch assumptions. A provable mismatch is
  // rejected with a static message — never raw Git output, which can carry paths
  // or remote URLs. When the branch is omitted we record the checkout's current
  // branch. An unborn checkout (no commits) has no resolvable branch to compare
  // against, so a claim is accepted rather than invented: real work always runs on
  // a checkout with commits.
  if (requestedBranch !== undefined) {
    let checkoutBranch: string | null
    try { checkoutBranch = getCurrentBranch(repo) } catch { checkoutBranch = null }
    if (checkoutBranch !== null && checkoutBranch !== requestedBranch) {
      return { ok: false, status: 409, body: { error: 'requested branch does not match the repository checkout' } }
    }
    return { ok: true, branch: requestedBranch }
  }
  try {
    return { ok: true, branch: getCurrentBranch(repo) }
  } catch (err: any) {
    return { ok: false, status: 400, body: { error: `could not determine branch: ${err.message}` } }
  }
}

// Build, persist and kick off a queued task from already-admitted inputs. Used by
// both POST / and POST /:id/retry so the two dispatch paths stay identical.
function dispatchTask(fields: {
  provider: AgentProvider
  autoCommit: boolean
  model: string | undefined
  repo: string
  branch: string
  prompt: string
}): string {
  const task: AgentTask = {
    id: uuidv4(),
    provider: fields.provider,
    autoCommit: fields.autoCommit,
    model: fields.model,
    repo: fields.repo,
    branch: fields.branch,
    prompt: fields.prompt,
    status: 'queued',
    log: '',
    createdAt: new Date().toISOString(),
  }

  insertTask(task)

  const emitter = createEmitter(task.id)

  // Run async — do not await here
  runTask(task, emitter).catch((err) => {
    console.error('[runner] uncaught error in runTask', err)
  })

  return task.id
}

export const tasksRouter = Router()
tasksRouter.use(capabilitiesRouter)

// POST /tasks — create and kick off a task
tasksRouter.post('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as RunRequest

  if (body.provider !== undefined && body.provider !== 'claude' && body.provider !== 'codex') {
    res.status(400).json({ error: 'provider must be claude or codex' })
    return
  }
  if (body.autoCommit !== undefined && typeof body.autoCommit !== 'boolean') {
    res.status(400).json({ error: 'autoCommit must be a boolean' })
    return
  }
  // Validate the optional model before any task is created. The pattern rejects
  // empty strings and a leading '-' (which could masquerade as a CLI flag); the
  // length cap bounds the argv token we hand to the provider.
  if (body.model !== undefined) {
    if (
      typeof body.model !== 'string' ||
      body.model.length > 100 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(body.model)
    ) {
      res.status(400).json({
        error: 'model must be 1-100 characters matching /^[A-Za-z0-9][A-Za-z0-9._-]*$/',
      })
      return
    }
  }

  if (typeof body.repo !== 'string' || !body.repo.trim() || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    res.status(400).json({ error: 'repo and prompt are required' })
    return
  }

  const checkout = resolveCheckout(body.repo)
  if (!checkout.ok) {
    res.status(checkout.status).json(checkout.body)
    return
  }
  const { repo } = checkout

  // Reject a malformed branch claim (body-level) before running shared admission;
  // admitCheckout receives an already-validated non-empty string or undefined.
  if (body.branch !== undefined && (typeof body.branch !== 'string' || !body.branch.trim())) {
    res.status(400).json({ error: 'branch must be a non-empty string' })
    return
  }

  const admission = admitCheckout(repo, body.branch)
  if (!admission.ok) {
    res.status(admission.status).json(admission.body)
    return
  }

  const taskId = dispatchTask({
    provider: body.provider ?? 'claude',
    autoCommit: body.autoCommit ?? config.autoCommit,
    model: body.model,
    repo,
    branch: admission.branch,
    prompt: body.prompt,
  })

  res.status(201).json({ taskId })
})

// GET /tasks — bounded history with exact stored-value filters.
// before is an exclusive task ID anchor (independent of filters). Missing anchors
// return JSON 404. X-Next-Before is present only when another page exists; reuse
// that ID as before with the same filters. The response body remains an array.
tasksRouter.get('/', (req: Request, res: Response) => {
  const repo = req.query.repo
  const status = req.query.status
  const before = req.query.before
  if (repo !== undefined && (typeof repo !== 'string' || !repo.trim())) {
    res.status(400).json({ error: 'repo must be a non-empty string' })
    return
  }
  const statuses: readonly TaskStatus[] = ['queued', 'running', 'completed', 'failed']
  if (status !== undefined && (typeof status !== 'string' || !statuses.includes(status as TaskStatus))) {
    res.status(400).json({ error: 'status must be queued, running, completed, or failed' })
    return
  }
  if (before !== undefined && (typeof before !== 'string' || !before.trim())) {
    res.status(400).json({ error: 'before must be a non-empty task ID' })
    return
  }
  if (before !== undefined && !db.prepare('SELECT id FROM tasks WHERE id = ?').get(before)) {
    res.status(404).json({ error: 'before task not found' })
    return
  }
  const rawLimit = req.query.limit
  const parsedLimit = typeof rawLimit === 'string' && rawLimit.trim() !== ''
    ? Number(rawLimit)
    : NaN
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(100, Math.max(1, Math.floor(parsedLimit)))
    : 20
  const rows = listTasks(limit + 1, { repo, status: status as TaskStatus | undefined, before })
  if (rows.length > limit) {
    rows.pop()
    res.setHeader('X-Next-Before', rows[rows.length - 1].id)
  }
  res.json(rows)
})

// GET /tasks/stats — aggregate task counts by status. Registered before GET
// /:id so Express does not capture 'stats' as a task id (which would 404 as a
// missing task). One grouped query covers every stored row; statuses absent from
// the result default to 0. total is the sum of the four reported buckets rather
// than a raw COUNT(*), so an unexpected stored status (none are written today)
// can never make total disagree with the buckets.
tasksRouter.get('/stats', (_req: Request, res: Response) => {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status')
    .all() as { status: TaskStatus; count: number }[]
  const counts: Record<TaskStatus, number> = { queued: 0, running: 0, completed: 0, failed: 0 }
  for (const row of rows) {
    if (row.status in counts) counts[row.status] += row.count
  }
  const total = counts.queued + counts.running + counts.completed + counts.failed
  res.json({ ...counts, total })
})

// GET /tasks/:id — single task
tasksRouter.get('/:id', (req: Request, res: Response) => {
  const view = req.query.view
  // A view query, when present, must name a known projection. Any other value —
  // a typo like ?view=statuss, or a repeated ?view=a&view=b array — is rejected
  // before any DB read rather than silently falling back to the full task (its
  // entire log and prompt), which would be a mild disclosure footgun.
  if (view !== undefined && view !== 'status' && view !== 'detail') {
    res.status(400).json({ error: "view must be 'status' or 'detail'" })
    return
  }
  const task = view === 'status' || view === 'detail'
    ? readTaskProjection(db, req.params.id, view)
    : getTask(req.params.id)
  if (!task) {
    res.status(404).json({ error: 'task not found' })
    return
  }
  res.json(task)
})

// GET /tasks/:id/stream — SSE stream
tasksRouter.get('/:id/stream', (req: Request, res: Response) => {
  const replay = req.query.replay !== '0' && req.query.replay !== 'false'
  const task = readTaskStreamSnapshot(db, req.params.id, replay)
  if (!task) {
    res.status(404).json({ error: 'task not found' })
    return
  }

  streamTask(req, res, task, getEmitter(task.id), replay)
})

// GET /tasks/:id/changes — concrete file footprint of the task's checkout.
// A distinct path segment from /:id/stream, so neither route shadows the other.
tasksRouter.get('/:id/changes', (req: Request, res: Response) => {
  // Changes need checkout identity and the recorded commit, never transcript data.
  const task = db.prepare(`
    SELECT id, repo, branch, commit_sha AS commitSha FROM tasks WHERE id = ?
  `).get(req.params.id) as {
    id: string; repo: string; branch: string; commitSha: string | null
  } | undefined
  if (!task) {
    res.status(404).json({ error: 'task not found' })
    return
  }

  // format selects the response shape: absent => the JSON file-footprint (default,
  // unchanged), 'patch' => the bounded unified diff as text/plain. Repeated, array,
  // or unknown values are rejected 400 (parse raw keys so a structured query fails too).
  const query = new URL(req.originalUrl, 'http://localhost').searchParams
  const formats = query.getAll('format')
  const structuredFormat = [...query.keys()].some(key => key.startsWith('format['))
  if (structuredFormat || formats.length > 1 || (formats.length === 1 && formats[0] !== 'patch')) {
    res.status(400).json({ error: "format must be omitted or 'patch'" })
    return
  }

  if (formats[0] === 'patch') {
    let patch
    try {
      patch = getChangesPatch(task.repo, task.commitSha ?? undefined)
    } catch {
      // Static message only: raw Git stderr can carry paths, remote URLs, or creds.
      res.status(503).json({ error: 'could not inspect repository changes' })
      return
    }
    res.setHeader('X-Patch-Truncated', patch.truncated ? 'true' : 'false')
    res.type('text/plain; charset=utf-8').send(patch.patch)
    return
  }

  let changedFiles
  try {
    changedFiles = getChangedFiles(task.repo, task.commitSha ?? undefined)
  } catch {
    // Static message only: raw Git stderr can carry paths, remote URLs, or creds.
    res.status(503).json({ error: 'could not inspect repository changes' })
    return
  }

  // Summarize the FULL set first so counts stay complete even when the emitted
  // list is capped; the cap keeps a pathological working tree from returning an
  // unbounded JSON body on the request thread.
  const summary = summarizeChangedFiles(changedFiles)
  const bounded = boundChangedFiles(changedFiles)

  res.json({
    taskId: task.id,
    repo: task.repo,
    branch: task.branch,
    summary,
    changedFiles: bounded.changedFiles,
    truncated: bounded.truncated,
  })
})

// POST /tasks/:id/retry — re-dispatch a terminal task's exact stored inputs as a
// brand-new task (new id). Reuses repo, prompt, provider, model and autoCommit;
// branch is re-resolved from the checkout via the shared admission guards, so a
// retry can never bypass the allowlist, conflict, disk, concurrency, or branch
// checks POST / enforces. Only completed/failed tasks are retryable.
tasksRouter.post('/:id/retry', (req: Request, res: Response) => {
  // Keep the complete original prompt for dispatch, but leave the stored log in SQLite.
  const source = db.prepare(`
    SELECT repo, prompt, provider, model, auto_commit AS autoCommit, status
    FROM tasks WHERE id = ?
  `).get(req.params.id) as {
    repo: string; prompt: string; provider: AgentProvider | null; model: string | null
    autoCommit: number | null; status: TaskStatus
  } | undefined
  if (!source) {
    res.status(404).json({ error: 'task not found' })
    return
  }
  if (source.status !== 'completed' && source.status !== 'failed') {
    res.status(409).json({ error: 'task is not in a terminal state' })
    return
  }

  const checkout = resolveCheckout(source.repo)
  if (!checkout.ok) {
    res.status(checkout.status).json(checkout.body)
    return
  }
  const { repo } = checkout
  const admission = admitCheckout(repo, undefined)
  if (!admission.ok) {
    res.status(admission.status).json(admission.body)
    return
  }

  const taskId = dispatchTask({
    provider: source.provider ?? 'claude',
    autoCommit: source.autoCommit == null ? config.autoCommit : Boolean(source.autoCommit),
    model: source.model ?? undefined,
    repo,
    branch: admission.branch,
    prompt: source.prompt,
  })

  res.status(201).json({ taskId })
})

// DELETE /tasks/:id — kill active task
tasksRouter.delete('/:id', (req: Request, res: Response) => {
  const task = readTaskProjection(db, req.params.id, 'status') as { status: TaskStatus } | undefined
  if (!task) {
    res.status(404).json({ error: 'task not found' })
    return
  }

  if (task.status !== 'running' && task.status !== 'queued') {
    res.status(409).json({ error: 'task is not active' })
    return
  }

  const killed = killTask(req.params.id)
  if (!killed) {
    // Persist the reason now; runTask owns terminal events and setup cleanup.
    db.transaction(() => {
      setErrorMessage(req.params.id, 'Task cancelled before launch')
      updateTaskStatus(req.params.id, 'failed')
    })()
  }

  res.json({ ok: true })
})
