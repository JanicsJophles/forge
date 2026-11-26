import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../config.js'
import { resolveAllowedRepo } from '../agent/repo-path.js'
import { executionIdentity } from '../agent/provider.js'
import {
  isAllowedTopic, taskWorkspacePath, validateWorkspace, workspaceLayout, workspaceTopic,
  type RunnerTask, type TaskRequest, type WorkspaceRequest,
} from '../agent/workspace.js'
import {
  insertTask,
  getTask,
  listTasks,
  countActiveTasks,
  updateTaskStatus,
} from '../db/queries.js'
import { createEmitter, getEmitter } from '../agent/stream.js'
import { runTask, killTask } from '../agent/runner.js'
import { invalidWatchdogOverride } from '../agent/watchdog.js'
import { getCurrentBranch } from '../agent/git.js'
import { db } from '../db/schema.js'
import { readTaskProjection, readTaskStatusList, readTaskPreviewList } from '../db/task-projection.js'

export const tasksRouter = Router()
// Versioned contract, not a claim that either CLI is authenticated.
tasksRouter.get('/capabilities', (_req, res) => {
  res.json({ providerSelectionVersion: 1, providers: ['claude', 'codex'] })
})

// POST /tasks — create and kick off a task
tasksRouter.post('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as TaskRequest

  if (body.provider !== undefined && body.provider !== 'claude' && body.provider !== 'codex') {
    res.status(400).json({ error: 'provider must be claude or codex' })
    return
  }
  if (body.autoCommit !== undefined && typeof body.autoCommit !== 'boolean') {
    res.status(400).json({ error: 'autoCommit must be a boolean' })
    return
  }

  for (const name of ['stallMinutes', 'exitGraceMinutes'] as const) {
    const problem = invalidWatchdogOverride(name, body[name])
    if (problem) {
      res.status(400).json({ error: problem })
      return
    }
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    res.status(400).json({ error: 'prompt is required' })
    return
  }
  if (body.workspace !== undefined && body.repo !== undefined) {
    res.status(400).json({ error: 'give repo or workspace, not both' })
    return
  }

  const id = uuidv4()
  let repo: string
  let branch = ''
  let workspace: WorkspaceRequest | undefined
  if (body.workspace !== undefined) {
    const checked = validateWorkspace(body.workspace, workspaceLayout)
    if ('error' in checked) {
      res.status(400).json({ error: checked.error })
      return
    }
    if (body.branch !== undefined && !isAllowedTopic(body.branch, workspaceLayout)) {
      res.status(400).json({ error: `branch must be a new topic branch under ${workspaceLayout.topicPrefixes.join(', ')}` })
      return
    }
    workspace = checked.spec
    // The worktree is created when the task starts; this is where it will be.
    repo = taskWorkspacePath(workspaceLayout, id)
    branch = workspaceTopic(id, body.branch)
  } else {
    if (typeof body.repo !== 'string' || !body.repo.trim()) {
      res.status(400).json({ error: 'repo or workspace is required' })
      return
    }
    // From here on only the canonical path is used: it reaches the root runner's chown and the agent's cwd.
    const resolved = resolveAllowedRepo(body.repo, config.allowedRepoPaths)
    if (!resolved) {
      res.status(400).json({ error: 'repo path is not in ALLOWED_REPO_PATHS' })
      return
    }
    repo = resolved
  }

  if (countActiveTasks() >= config.maxConcurrentTasks) {
    res.status(429).json({ error: 'max concurrent tasks reached' })
    return
  }

  if (!workspace) {
    try {
      // git reads the clone's own .git/config, which agents write: run it as the agent account, never as root.
      branch = body.branch ?? getCurrentBranch(repo, executionIdentity(config.claudeRunUser))
    } catch (err: any) {
      res.status(400).json({ error: `could not determine branch: ${err.message}` })
      return
    }
  }

  const task: RunnerTask = {
    id,
    provider: body.provider ?? 'claude',
    autoCommit: body.autoCommit ?? config.autoCommit,
    repo,
    branch,
    prompt: body.prompt,
    status: 'queued',
    log: '',
    createdAt: new Date().toISOString(),
    ...(workspace ? { workspace } : {}),
    ...(typeof body.stallMinutes === 'number' ? { stallMinutes: body.stallMinutes } : {}),
    ...(typeof body.exitGraceMinutes === 'number' ? { exitGraceMinutes: body.exitGraceMinutes } : {}),
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
tasksRouter.get('/', (req: Request, res: Response) => {
  res.json(req.query.view === 'status' ? readTaskStatusList(db)
    : req.query.view === 'list' ? readTaskPreviewList(db) : listTasks(20))
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
