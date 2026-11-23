import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import type { AgentTask, RunRequest } from '@forge/shared'
import { config, isRepoAllowed } from '../config.js'
import {
  insertTask,
  getTask,
  listTasks,
  countActiveTasks,
  updateTaskStatus,
  LIST_LOG_TAIL_BYTES,
} from '../db/queries.js'
import { createEmitter, getEmitter } from '../agent/stream.js'
import { runTask, killTask } from '../agent/runner.js'
import { getCurrentBranch } from '../agent/git.js'
import { db } from '../db/schema.js'
import { readTaskProjection } from '../db/task-projection.js'
import { getCapabilities } from '../capabilities.js'

export const tasksRouter = Router()
tasksRouter.get('/capabilities', (_req, res) => {
  res.json(getCapabilities())
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
  if (body.readOnly !== undefined && typeof body.readOnly !== 'boolean') {
    res.status(400).json({ error: 'readOnly must be a boolean' })
    return
  }

  // Refuse read-only tasks unless this runner can actually enforce them (a usable,
  // isolated read-only account is configured). Never silently downgrade to writable.
  if (body.readOnly === true && !getCapabilities().readOnly) {
    res.status(400).json({ error: 'read-only is not supported by this runner: READONLY_RUN_USER is not configured or the account does not exist' })
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

  if (countActiveTasks() >= config.maxConcurrentTasks) {
    res.status(429).json({ error: 'max concurrent tasks reached' })
    return
  }

  let branch: string
  try {
    branch = body.branch ?? getCurrentBranch(body.repo)
  } catch (err: any) {
    res.status(400).json({ error: `could not determine branch: ${err.message}` })
    return
  }

  const readOnly = body.readOnly ?? false
  const task: AgentTask = {
    id: uuidv4(),
    provider: body.provider ?? 'claude',
    // Read-only tasks never commit, regardless of the requested autoCommit.
    autoCommit: readOnly ? false : (body.autoCommit ?? config.autoCommit),
    readOnly,
    repo: body.repo,
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

// GET /tasks — last 20, with each task's log capped to its trailing bytes so a
// large transcript cannot bloat the list response (GET /tasks/:id keeps the full log).
tasksRouter.get('/', (_req: Request, res: Response) => {
  res.json(listTasks(20, LIST_LOG_TAIL_BYTES))
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
  // Mark the task failed when it is not actively running an agent OR when it is still
  // queued. The queued case closes the finding-G window: a read-only task cancelled
  // during its (up-to-two-minute) copy preparation has a prep child registered, so
  // killTask returns true — but the task row is still 'queued'. Flipping it to 'failed'
  // here means the runner's post-prep status re-check sees a non-queued task and aborts
  // before the agent ever starts, instead of racing the cancel.
  if (!killed || task.status === 'queued') {
    updateTaskStatus(task.id, 'failed')
  }

  res.json({ ok: true })
})
