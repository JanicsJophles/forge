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
} from '../db/queries.js'
import { createEmitter, getEmitter } from '../agent/stream.js'
import { runTask, killTask } from '../agent/runner.js'
import { getCurrentBranch } from '../agent/git.js'

export const tasksRouter = Router()

// POST /tasks — create and kick off a task
tasksRouter.post('/', (req: Request, res: Response) => {
  const body = req.body as RunRequest

  if (!body.repo || !body.prompt) {
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

  const task: AgentTask = {
    id: uuidv4(),
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

// GET /tasks — last 20
tasksRouter.get('/', (_req: Request, res: Response) => {
  res.json(listTasks(20))
})

// GET /tasks/:id — single task
tasksRouter.get('/:id', (req: Request, res: Response) => {
  const task = getTask(req.params.id)
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
