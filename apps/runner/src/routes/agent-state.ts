// ---------------------------------------------------------------------------
// /agent-state — coordination surface for local and forge agents.
//
//   POST /agent-state/checkpoint    upsert this agent's live state
//   GET  /agent-state               list all live (non-expired) agents
//   GET  /agent-state/:agentId      fetch one
//   DELETE /agent-state/:agentId    remove (clean shutdown)
//
//   POST /agent-events              append a transition event
//   GET  /agent-events              list recent events (filterable)
//
//   GET  /agent-context             combined snapshot: live agents +
//                                   up to 200 newest events from the last 24h,
//                                   with explicit truncation metadata, plus a
//                                   runner-wide `capacity` block (active tasks,
//                                   max concurrency, available slots).
//                                   ?repo=<name> narrows every collection and
//                                   its counts to that repo — but NOT capacity,
//                                   since concurrency is global.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response } from 'express'
import {
  checkpoint,
  listAgentState,
  getAgentState,
  deleteAgentState,
  gcAgentState,
  insertEvent,
  listEvents,
  gcAgentEvents,
  type CheckpointInput,
  type EventInput,
} from '../db/agent-state.js'
import { db } from '../db/schema.js'
import { listActiveTasks, countActiveTasks } from '../db/queries.js'
import { config } from '../config.js'

export const agentStateRouter = Router()

function badRequest(res: Response, msg: string): void {
  res.status(400).json({ error: msg })
}

// UTF-8 byte limits apply before persistence; never slice identities or JSON.
const MAX_SCALAR_BYTES = 500
const MAX_STRUCTURED_BYTES = 16 * 1024

function exceedsBounds(body: Record<string, unknown>, fields: string[], structured: string): boolean {
  if (fields.some(field => typeof body[field] === 'string' &&
      Buffer.byteLength(body[field] as string, 'utf8') > MAX_SCALAR_BYTES)) return true
  const value = body[structured]
  return value !== null && typeof value === 'object' &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_STRUCTURED_BYTES
}

// Use the same parser as listEvents, rather than Date.parse's different formats.
function validSince(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'string' || !value.trim()) return false
  const result = db.prepare("SELECT strftime('%Y-%m-%d %H:%M:%f', ?) AS timestamp").get(value) as { timestamp: string | null }
  return result.timestamp !== null
}

// ---- agent_state -----------------------------------------------------------

agentStateRouter.post('/agent-state/checkpoint', (req: Request, res: Response) => {
  const b = req.body ?? {}
  if (typeof b.agentId !== 'string' || !b.agentId.trim()) {
    return badRequest(res, 'agentId is required')
  }
  if (exceedsBounds(b, ['agentId', 'agentType', 'repo', 'branch', 'intent', 'ticket', 'status'], 'metadata')) {
    return badRequest(res, 'checkpoint payload exceeds field size limits')
  }
  const input: CheckpointInput = {
    agentId: b.agentId.trim(),
    agentType: typeof b.agentType === 'string' ? b.agentType : undefined,
    repo: b.repo === null || typeof b.repo === 'string' ? b.repo : undefined,
    branch: b.branch === null || typeof b.branch === 'string' ? b.branch : undefined,
    intent: b.intent === null || typeof b.intent === 'string' ? b.intent : undefined,
    filesTouched: b.filesTouched === null ? null : Array.isArray(b.filesTouched) ? b.filesTouched.filter((x: unknown) => typeof x === 'string') as string[] : undefined,
    ticket: b.ticket === null || typeof b.ticket === 'string' ? b.ticket : undefined,
    status: b.status === null || typeof b.status === 'string' ? b.status : undefined,
    ttlSeconds: typeof b.ttlSeconds === 'number' ? b.ttlSeconds : undefined,
    metadata: b.metadata === null ? null : b.metadata && typeof b.metadata === 'object' ? b.metadata : undefined,
  }
  const result = checkpoint(input)
  res.json(result)
})

agentStateRouter.get('/agent-state', (req: Request, res: Response) => {
  const includeExpired = req.query.includeExpired === 'true' || req.query.includeExpired === '1'
  const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : undefined
  const rows = listAgentState({ repo, ticket, includeExpired })
  res.json(rows)
})

agentStateRouter.get('/agent-state/:agentId', (req: Request, res: Response) => {
  const found = getAgentState(req.params.agentId)
  if (!found) return res.status(404).json({ error: 'not found' })
  res.json(found)
})

agentStateRouter.delete('/agent-state/:agentId', (req: Request, res: Response) => {
  const ok = deleteAgentState(req.params.agentId)
  res.json({ deleted: ok })
})

// ---- agent_events ----------------------------------------------------------

agentStateRouter.post('/agent-events', (req: Request, res: Response) => {
  const b = req.body ?? {}
  if (typeof b.eventType !== 'string' || !b.eventType.trim()) {
    return badRequest(res, 'eventType is required')
  }
  if (b.prNumber != null && (!Number.isSafeInteger(b.prNumber) || b.prNumber <= 0)) {
    return badRequest(res, 'prNumber must be a positive safe integer')
  }
  if (exceedsBounds(b, ['eventType', 'repo', 'ticket', 'agentId'], 'details')) {
    return badRequest(res, 'event payload exceeds field size limits')
  }
  const input: EventInput = {
    eventType: b.eventType.trim(),
    repo: typeof b.repo === 'string' ? b.repo : undefined,
    ticket: typeof b.ticket === 'string' ? b.ticket : undefined,
    prNumber: typeof b.prNumber === 'number' ? b.prNumber : undefined,
    agentId: typeof b.agentId === 'string' ? b.agentId : undefined,
    details: b.details && typeof b.details === 'object' ? b.details : undefined,
  }
  const result = insertEvent(input)
  res.status(201).json(result)
})

agentStateRouter.get('/agent-events', (req: Request, res: Response) => {
  const agentId = req.query.agentId
  if (agentId !== undefined && (typeof agentId !== 'string' || !agentId.trim())) {
    return badRequest(res, 'agentId must be a single nonempty string')
  }
  const rawAfterId = req.query.afterId
  let afterId: number | undefined
  if (rawAfterId !== undefined) {
    if (typeof rawAfterId !== 'string' || !/^[0-9]+$/.test(rawAfterId) ||
        !Number.isSafeInteger(Number(rawAfterId))) {
      return badRequest(res, 'afterId must be a single nonnegative safe integer decimal')
    }
    if (req.query.since !== undefined) {
      return badRequest(res, 'since and afterId cannot be used together')
    }
    afterId = Number(rawAfterId)
  }
  if (!validSince(req.query.since)) {
    return badRequest(res, 'since must be a single parseable SQLite UTC or ISO timestamp')
  }
  const since = typeof req.query.since === 'string' ? req.query.since : undefined
  const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : undefined
  const eventType = typeof req.query.type === 'string' ? req.query.type : undefined
  const rawLimit = req.query.limit
  let limit: number | undefined
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^[0-9]+$/.test(rawLimit) ||
        !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) <= 0) {
      return badRequest(res, 'limit must be a single positive safe integer decimal')
    }
    // listEvents defaults to 100 and caps valid larger limits at 1000.
    limit = Number(rawLimit)
  }
  const rows = listEvents({ since, afterId, repo, ticket, eventType, agentId, limit })
  res.json(rows)
})

// ---- combined dashboard ----------------------------------------------------

agentStateRouter.get('/agent-context', (req: Request, res: Response) => {
  if (!validSince(req.query.since)) {
    return badRequest(res, 'since must be a single parseable SQLite UTC or ISO timestamp')
  }
  // Mirror the /tasks repo-filter validation: present-but-blank is rejected.
  const rawRepo = req.query.repo
  if (rawRepo !== undefined && (typeof rawRepo !== 'string' || !rawRepo.trim())) {
    return badRequest(res, 'repo must be a non-empty string')
  }
  const repo = typeof rawRepo === 'string' ? rawRepo : undefined
  const since = typeof req.query.since === 'string'
    ? req.query.since
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')

  const live = listAgentState({ repo })
  const eventWindow = listEvents({ since, repo, limit: 201 })
  const events = eventWindow.slice(0, 200)
  const liveTasks = repo === undefined
    ? listActiveTasks()
    : listActiveTasks().filter(t => t.repo === repo)

  // Sweep dust on every call. Cheap on small tables.
  gcAgentState()
  gcAgentEvents()

  // Helpful denormalised summary so consumers don't reduce themselves.
  const liveByRepo: Record<string, number> = Object.create(null)
  const liveByTicket: Record<string, number> = Object.create(null)
  for (const a of live) {
    if (a.repo) liveByRepo[a.repo] = (liveByRepo[a.repo] ?? 0) + 1
    if (a.ticket) liveByTicket[a.ticket] = (liveByTicket[a.ticket] ?? 0) + 1
  }

  // Runner's own queued/running tasks, so agents can see a forge task is
  // already active in a repo (not just the checkpointed agent_state rows).
  const liveTasksByRepo: Record<string, number> = Object.create(null)
  for (const t of liveTasks) {
    liveTasksByRepo[t.repo] = (liveTasksByRepo[t.repo] ?? 0) + 1
  }

  // Runner-wide concurrency budget, deliberately NOT narrowed by ?repo= —
  // MAX_CONCURRENT_TASKS is global, so a dispatcher can answer "can I launch
  // another task now?" from this one call.
  const activeTasks = countActiveTasks()
  const maxConcurrentTasks = config.maxConcurrentTasks
  const capacity = {
    activeTasks,
    maxConcurrentTasks,
    availableSlots: Math.max(0, maxConcurrentTasks - activeTasks),
  }

  res.json({
    generatedAt: new Date().toISOString(),
    liveAgents: live,
    liveAgentsCount: live.length,
    liveByRepo,
    liveByTicket,
    liveTasks,
    liveTasksCount: liveTasks.length,
    liveTasksByRepo,
    capacity,
    recentEvents: events,
    recentEventsCount: events.length,
    recentEventsTruncated: eventWindow.length > 200,
    // Snapshot boundary only: timestamp ordering means this is not a paging cursor.
    recentEventsOldestId: events.at(-1)?.id ?? null,
    since,
  })
})
