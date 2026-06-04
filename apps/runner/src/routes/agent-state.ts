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
//
//   POST /agent-candidates          add a captured stuckpoint candidate
//   GET  /agent-candidates          list pending (default status=new) candidates
//   GET  /agent-candidates/:id      fetch one
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
import {
  insertCandidate,
  listCandidates,
  getCandidate,
  gcCandidates,
  type ListCandidatesFilter,
} from '../db/candidates.js'
import type { CandidateInput, CandidateStatus, CandidateSource } from '@forge/shared'

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

  res.json({
    generatedAt: new Date().toISOString(),
    liveAgents: live,
    liveAgentsCount: live.length,
    liveByRepo,
    liveByTicket,
    recentEvents: events,
    recentEventsCount: events.length,
    since,
  })
})

// ---- agent_candidates (RAC-378 stuckpoint sink) ----------------------------

const VALID_SOURCES: CandidateSource[] = ['testing-loop', 'web-harvest']
const VALID_STATUSES: CandidateStatus[] = ['new', 'queued', 'promoted', 'rejected']

agentStateRouter.post('/agent-candidates', (req: Request, res: Response) => {
  const b = req.body ?? {}
  // Minimal contract: source + the three failureMode-mapped strings.
  if (typeof b.source !== 'string' || !VALID_SOURCES.includes(b.source as CandidateSource)) {
    return badRequest(res, `source must be one of: ${VALID_SOURCES.join(', ')}`)
  }
  if (typeof b.symptom !== 'string' || !b.symptom.trim()) {
    return badRequest(res, 'symptom is required')
  }
  if (typeof b.cause !== 'string' || !b.cause.trim()) {
    return badRequest(res, 'cause is required')
  }
  if (typeof b.fix !== 'string' || !b.fix.trim()) {
    return badRequest(res, 'fix is required')
  }

  const input: CandidateInput = {
    source: b.source as CandidateSource,
    symptom: b.symptom.trim(),
    cause: b.cause.trim(),
    fix: b.fix.trim(),
    candidateId: typeof b.candidateId === 'string' ? b.candidateId : undefined,
    originAgentId: typeof b.originAgentId === 'string' ? b.originAgentId : undefined,
    originRepo: typeof b.originRepo === 'string' ? b.originRepo : undefined,
    originTicket: typeof b.originTicket === 'string' ? b.originTicket : undefined,
    capturedAt: typeof b.capturedAt === 'string' ? b.capturedAt : undefined,
    proposedCluster: typeof b.proposedCluster === 'string' ? b.proposedCluster : undefined,
    diagnosticSteps: Array.isArray(b.diagnosticSteps)
      ? b.diagnosticSteps.filter((x: unknown) => typeof x === 'string')
      : undefined,
    severity: typeof b.severity === 'string' ? b.severity as CandidateInput['severity'] : undefined,
    verifiedCommand: typeof b.verifiedCommand === 'string' ? b.verifiedCommand : undefined,
    deadEnds: Array.isArray(b.deadEnds) ? b.deadEnds : undefined,
    reproduction: b.reproduction && typeof b.reproduction === 'object' ? b.reproduction : undefined,
    rawEvidence: typeof b.rawEvidence === 'string' ? b.rawEvidence : undefined,
    status:
      typeof b.status === 'string' && VALID_STATUSES.includes(b.status as CandidateStatus)
        ? (b.status as CandidateStatus)
        : undefined,
    groundingSources: Array.isArray(b.groundingSources)
      ? b.groundingSources.filter((x: unknown) => typeof x === 'string')
      : undefined,
    confidence: b.confidence === 'high' || b.confidence === 'medium' ? b.confidence : undefined,
    nicheLevel: typeof b.nicheLevel === 'string' ? b.nicheLevel : undefined,
    mechanismVerified: typeof b.mechanismVerified === 'boolean' ? b.mechanismVerified : undefined,
    commandRecheck:
      b.commandRecheck && typeof b.commandRecheck === 'object' ? b.commandRecheck : undefined,
  }

  const result = insertCandidate(input)
  res.status(201).json(result)
})

agentStateRouter.get('/agent-candidates', (req: Request, res: Response) => {
  // Default to pending work (status=new) so the gate (RAC-380) gets its queue
  // without having to filter. Pass ?status=all to see everything.
  const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'new'
  const filter: ListCandidatesFilter = {}
  if (rawStatus !== 'all') {
    filter.status = VALID_STATUSES.includes(rawStatus as CandidateStatus)
      ? (rawStatus as CandidateStatus)
      : 'new'
  }
  if (typeof req.query.source === 'string' && VALID_SOURCES.includes(req.query.source as CandidateSource)) {
    filter.source = req.query.source as CandidateSource
  }
  if (typeof req.query.repo === 'string') filter.repo = req.query.repo
  if (typeof req.query.limit === 'string') {
    const n = parseInt(req.query.limit, 10)
    if (Number.isFinite(n)) filter.limit = n
  }

  // Cheap sweep of processed dust, mirroring /agent-context.
  gcCandidates()

  const rows = listCandidates(filter)
  res.json(rows)
})

agentStateRouter.get('/agent-candidates/:candidateId', (req: Request, res: Response) => {
  const found = getCandidate(req.params.candidateId)
  if (!found) return res.status(404).json({ error: 'not found' })
  res.json(found)
})
