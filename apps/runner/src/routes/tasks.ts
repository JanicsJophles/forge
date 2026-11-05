import { realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import type { AgentTask, RunRequest } from '@forge/shared'
import { config, isRepoAllowed } from '../config.js'
import {
  insertTask,
  getTask,
  listTasks,
  countActiveTasks,
  listActiveTasks,
  updateTaskStatus,
} from '../db/queries.js'
import { createEmitter, getEmitter } from '../agent/stream.js'
import { runTask, killTask } from '../agent/runner.js'
import { getCurrentBranch } from '../agent/git.js'
import { freeDiskBytes } from '../agent/disk.js'
import { db } from '../db/schema.js'
import { readTaskProjection } from '../db/task-projection.js'

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
// Versioned contract, not a claim that either CLI is authenticated.
tasksRouter.get('/capabilities', (_req, res) => {
  res.json({ providerSelectionVersion: 1, providers: ['claude', 'codex'] })
})

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
  try {
    const freeBytes = freeDiskBytes(repo)
    if (freeBytes < minFreeBytes) {
      res.status(507).json({
        error: 'insufficient disk space to accept new tasks',
        freeMb: Math.floor(freeBytes / (1024 * 1024)),
        requiredMb: config.minFreeDiskMb,
      })
      return
    }
  } catch (err: any) {
    console.warn(`[runner] disk-space check failed for ${body.repo}, allowing task: ${err.message}`)
  }

  if (countActiveTasks() >= config.maxConcurrentTasks) {
    res.status(429).json({ error: 'max concurrent tasks reached' })
    return
  }

  let branch: string
  try {
    branch = body.branch ?? getCurrentBranch(repo)
  } catch (err: any) {
    res.status(400).json({ error: `could not determine branch: ${err.message}` })
    return
  }

  const task: AgentTask = {
    id: uuidv4(),
    provider: body.provider ?? 'claude',
    autoCommit: body.autoCommit ?? config.autoCommit,
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

// GET /tasks — last 20
tasksRouter.get('/', (_req: Request, res: Response) => {
  res.json(listTasks(20))
})

// GET /tasks/:id — single task
tasksRouter.get('/:id', (req: Request, res: Response) => {
  const view = req.query.view
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

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // disable nginx buffering
  res.flushHeaders()

  function send(event: string, data: string) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  // Catch-up: send existing log immediately for reconnects
  if (task.log) {
    send('log', task.log)
  }

  // If already terminal, send final status and close
  if (task.status === 'completed' || task.status === 'failed') {
    send(task.status === 'completed' ? 'complete' : 'error', task.status)
    res.end()
    return
  }

  const emitter = getEmitter(task.id)
  if (!emitter) {
    // Task was running but emitter is gone (e.g. process crashed) — close
    send('error', 'task emitter not found — task may have crashed')
    res.end()
    return
  }

  // Ping every 15s to keep connection alive through proxies/load balancers
  const ping = setInterval(() => {
    res.write(': ping\n\n')
  }, 15_000)

  function onEvent(taskEvent: { type: string; data: string }) {
    send(taskEvent.type, taskEvent.data)
  }

  function onDone() {
    cleanup()
    res.end()
  }

  function cleanup() {
    clearInterval(ping)
    emitter!.off('event', onEvent)
    emitter!.off('done', onDone)
  }

  emitter.on('event', onEvent)
  emitter.on('done', onDone)

  // Clean up if client disconnects early
  req.on('close', cleanup)
})

// DELETE /tasks/:id — kill active task
tasksRouter.delete('/:id', (req: Request, res: Response) => {
  const task = getTask(req.params.id)
  if (!task) {
    res.status(404).json({ error: 'task not found' })
    return
  }

  if (task.status !== 'running' && task.status !== 'queued') {
    res.status(409).json({ error: 'task is not active' })
    return
  }

  const killed = killTask(task.id)
  if (!killed) {
    // Queued but not started yet — just mark failed
    updateTaskStatus(task.id, 'failed')
  }

  res.json({ ok: true })
})
