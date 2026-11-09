import { realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import type { AgentTask, RunRequest, TaskStatus } from '@forge/shared'
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
import { getChangedFiles } from '../agent/git-changes.js'
import { freeDiskBytes } from '../agent/disk.js'
import { db } from '../db/schema.js'
import { readTaskProjection } from '../db/task-projection.js'
import { capabilitiesRouter } from './capabilities.js'

import { streamTask } from './task-stream.js'

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

  if (!isRepoAllowed(body.repo)) {
    res.status(400).json({ error: 'repo path is not in ALLOWED_REPO_PATHS' })
    return
  }

  let repo: string
  try {
    repo = realpathSync(body.repo)
    if (!statSync(repo).isDirectory()) throw new Error('not a directory')
  } catch {
    res.status(400).json({ error: 'repo must be an existing directory' })
    return
  }
  if (!isRepoAllowed(repo)) {
    res.status(400).json({ error: 'repo path is not in ALLOWED_REPO_PATHS' })
    return
  }

  try {
    repo = checkoutRoot(repo)
  } catch {
    res.status(400).json({ error: 'repo must be inside a Git checkout with a discoverable root' })
    return
  }
  if (!isRepoAllowed(repo)) {
    res.status(400).json({ error: 'repo checkout root is not in ALLOWED_REPO_PATHS' })
    return
  }

  // Keep admission synchronous through insertTask: queued login probes also
  // own their checkout. Resolve older rows too, since they may contain aliases.
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
    res.status(409).json({ error: 'repo checkout already has an active task', taskId: conflict.id })
    return
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
        res.status(507).json({
          error: 'insufficient disk space to accept new tasks',
          volume,
          freeMb: Math.floor(freeBytes / (1024 * 1024)),
          requiredMb: config.minFreeDiskMb,
        })
        return
      }
    } catch (err: any) {
      console.warn(`[runner] ${volume} disk-space check failed, measurement unknown: ${err.message}`)
    }
  }

  if (countActiveTasks() >= config.maxConcurrentTasks) {
    res.status(429).json({ error: 'max concurrent tasks reached' })
    return
  }

  // Validate the branch claim against the checkout so two callers cannot race
  // the same working tree under mismatched branch assumptions. When the caller
  // names a branch it must match the checkout's current branch; a provable
  // mismatch is rejected with a static message — never raw Git output, which can
  // carry paths or remote URLs. When the branch is omitted we record the
  // checkout's current branch as before. An unborn checkout (no commits) has no
  // resolvable branch to compare against, so a claim is accepted rather than
  // invented: real work always runs on a checkout with commits.
  let branch: string
  if (body.branch !== undefined) {
    if (typeof body.branch !== 'string' || !body.branch.trim()) {
      res.status(400).json({ error: 'branch must be a non-empty string' })
      return
    }
    let checkoutBranch: string | null
    try {
      checkoutBranch = getCurrentBranch(repo)
    } catch {
      checkoutBranch = null
    }
    if (checkoutBranch !== null && checkoutBranch !== body.branch) {
      res.status(409).json({ error: 'requested branch does not match the repository checkout' })
      return
    }
    branch = body.branch
  } else {
    try {
      branch = getCurrentBranch(repo)
    } catch (err: any) {
      res.status(400).json({ error: `could not determine branch: ${err.message}` })
      return
    }
  }

  const task: AgentTask = {
    id: uuidv4(),
    provider: body.provider ?? 'claude',
    autoCommit: body.autoCommit ?? config.autoCommit,
    model: body.model,
    repo,
    branch,
    prompt: body.prompt,
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

  res.status(201).json({ taskId: task.id })
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
  const task = getTask(req.params.id)
  if (!task) {
    res.status(404).json({ error: 'task not found' })
    return
  }

  const replay = req.query.replay !== '0' && req.query.replay !== 'false'
  streamTask(req, res, task, getEmitter(task.id), replay)
})

// GET /tasks/:id/changes — concrete file footprint of the task's checkout.
// A distinct path segment from /:id/stream, so neither route shadows the other.
tasksRouter.get('/:id/changes', (req: Request, res: Response) => {
  const task = getTask(req.params.id)
  if (!task) {
    res.status(404).json({ error: 'task not found' })
    return
  }

  let changedFiles
  try {
    changedFiles = getChangedFiles(task.repo)
  } catch {
    // Static message only: raw Git stderr can carry paths, remote URLs, or creds.
    res.status(503).json({ error: 'could not inspect repository changes' })
    return
  }

  res.json({ taskId: task.id, repo: task.repo, branch: task.branch, changedFiles })
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
