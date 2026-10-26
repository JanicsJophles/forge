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
//                                   last 24h of events. The "one call that
//                                   tells you everything" endpoint.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response } from 'express'
import {
  checkpoint,
  listAgentState,
  deleteAgentState,
  gcAgentState,
  insertEvent,
  listEvents,
  gcAgentEvents,
  type CheckpointInput,
  type EventInput,
} from '../db/agent-state.js'
import { listActiveTasks } from '../db/queries.js'

export const agentStateRouter = Router()

function badRequest(res: Response, msg: string): void {
  res.status(400).json({ error: msg })
}

// ---- agent_state -----------------------------------------------------------

agentStateRouter.post('/agent-state/checkpoint', (req: Request, res: Response) => {
  const b = req.body ?? {}
  if (typeof b.agentId !== 'string' || !b.agentId.trim()) {
    return badRequest(res, 'agentId is required')
  }
  const input: CheckpointInput = {
    agentId: b.agentId.trim(),
    agentType: typeof b.agentType === 'string' ? b.agentType : undefined,
    repo: typeof b.repo === 'string' ? b.repo : undefined,
    branch: typeof b.branch === 'string' ? b.branch : undefined,
    intent: typeof b.intent === 'string' ? b.intent : undefined,
    filesTouched: Array.isArray(b.filesTouched) ? b.filesTouched.filter((x: unknown) => typeof x === 'string') as string[] : undefined,
    ticket: typeof b.ticket === 'string' ? b.ticket : undefined,
    status: typeof b.status === 'string' ? b.status : undefined,
    ttlSeconds: typeof b.ttlSeconds === 'number' ? b.ttlSeconds : undefined,
    metadata: b.metadata && typeof b.metadata === 'object' ? b.metadata : undefined,
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
  const all = listAgentState({ includeExpired: true })
  const found = all.find(r => r.agentId === req.params.agentId)
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
  const since = typeof req.query.since === 'string' ? req.query.since : undefined
  const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : undefined
  const eventType = typeof req.query.type === 'string' ? req.query.type : undefined
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined
  const rows = listEvents({ since, repo, ticket, eventType, limit: Number.isFinite(limit) ? limit : undefined })
  res.json(rows)
})

// ---- combined dashboard ----------------------------------------------------

agentStateRouter.get('/agent-context', (req: Request, res: Response) => {
  const since = typeof req.query.since === 'string'
    ? req.query.since
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')

  const live = listAgentState({})
  const events = listEvents({ since, limit: 200 })
  const liveTasks = listActiveTasks()

  // Sweep dust on every call. Cheap on small tables.
  gcAgentState()
  gcAgentEvents()

  // Helpful denormalised summary so consumers don't reduce themselves.
  const liveByRepo: Record<string, number> = {}
  const liveByTicket: Record<string, number> = {}
  for (const a of live) {
    if (a.repo) liveByRepo[a.repo] = (liveByRepo[a.repo] ?? 0) + 1
    if (a.ticket) liveByTicket[a.ticket] = (liveByTicket[a.ticket] ?? 0) + 1
  }

  // Runner's own queued/running tasks, so agents can see a forge task is
  // already active in a repo (not just the checkpointed agent_state rows).
  const liveTasksByRepo: Record<string, number> = {}
  for (const t of liveTasks) {
    liveTasksByRepo[t.repo] = (liveTasksByRepo[t.repo] ?? 0) + 1
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
    recentEvents: events,
    recentEventsCount: events.length,
    since,
  })
})
