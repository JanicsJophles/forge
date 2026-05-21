// ---------------------------------------------------------------------------
// agent-state: shared coordination board for local and remote (forge) agents
// ---------------------------------------------------------------------------
// Two append-and-upsert surfaces sit on top of the same SQLite DB the runner
// already uses:
//
//   agent_state  — live, TTL-d snapshot of every agent currently working.
//                  "I'm editing X, on branch Y, working on ticket Z." Updated
//                  via checkpoint calls; expired rows are filtered at read.
//
//   agent_events — append-only log of important transitions. PR merged, PR
//                  failed CI, ticket marked Done, forge dispatched, etc.
//                  Lets a fresh agent catch up on the last 24h with one query.
//
// Both tables are owned by this file. No cross-file imports of the raw db
// handle except via the public functions below.
// ---------------------------------------------------------------------------

import { db } from './schema.js'

// ---- schema bootstrap ------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_state (
    agent_id      TEXT PRIMARY KEY,
    agent_type    TEXT NOT NULL,
    repo          TEXT,
    branch        TEXT,
    intent        TEXT,
    files_touched TEXT,
    ticket        TEXT,
    status        TEXT,
    expires_at    TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    metadata      TEXT
  );
  CREATE INDEX IF NOT EXISTS agent_state_expires_idx ON agent_state(expires_at);
  CREATE INDEX IF NOT EXISTS agent_state_repo_idx    ON agent_state(repo);
  CREATE INDEX IF NOT EXISTS agent_state_ticket_idx  ON agent_state(ticket);

  CREATE TABLE IF NOT EXISTS agent_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT NOT NULL,
    repo        TEXT,
    ticket      TEXT,
    pr_number   INTEGER,
    agent_id    TEXT,
    details     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS agent_events_created_idx ON agent_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS agent_events_repo_idx    ON agent_events(repo);
  CREATE INDEX IF NOT EXISTS agent_events_ticket_idx  ON agent_events(ticket);
  CREATE INDEX IF NOT EXISTS agent_events_type_idx    ON agent_events(event_type);
`)

// ---- types -----------------------------------------------------------------

export interface AgentState {
  agentId: string
  agentType: string
  repo?: string | null
  branch?: string | null
  intent?: string | null
  filesTouched?: string[] | null
  ticket?: string | null
  status?: string | null
  expiresAt: string
  createdAt: string
  updatedAt: string
  metadata?: Record<string, unknown> | null
}

export interface AgentEvent {
  id: number
  eventType: string
  repo?: string | null
  ticket?: string | null
  prNumber?: number | null
  agentId?: string | null
  details?: Record<string, unknown> | null
  createdAt: string
}

interface AgentStateRow {
  agent_id: string
  agent_type: string
  repo: string | null
  branch: string | null
  intent: string | null
  files_touched: string | null
  ticket: string | null
  status: string | null
  expires_at: string
  created_at: string
  updated_at: string
  metadata: string | null
}

interface AgentEventRow {
  id: number
  event_type: string
  repo: string | null
  ticket: string | null
  pr_number: number | null
  agent_id: string | null
  details: string | null
  created_at: string
}

function parseJson<T>(v: string | null): T | null {
  if (v == null) return null
  try { return JSON.parse(v) as T } catch { return null }
}

function rowToState(row: AgentStateRow): AgentState {
  return {
    agentId: row.agent_id,
    agentType: row.agent_type,
    repo: row.repo,
    branch: row.branch,
    intent: row.intent,
    filesTouched: parseJson<string[]>(row.files_touched),
    ticket: row.ticket,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<Record<string, unknown>>(row.metadata),
  }
}

function rowToEvent(row: AgentEventRow): AgentEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    repo: row.repo,
    ticket: row.ticket,
    prNumber: row.pr_number,
    agentId: row.agent_id,
    details: parseJson<Record<string, unknown>>(row.details),
    createdAt: row.created_at,
  }
}

// ---- upsert / read agent_state ---------------------------------------------

export interface CheckpointInput {
  agentId: string
  agentType?: string
  repo?: string | null
  branch?: string | null
  intent?: string | null
  filesTouched?: string[] | null
  ticket?: string | null
  status?: string | null
  ttlSeconds?: number
  metadata?: Record<string, unknown> | null
}

const DEFAULT_TTL_SECONDS = 3600 // 1h — agents that go idle this long are stale

export function checkpoint(input: CheckpointInput): AgentState {
  const ttl = Math.max(60, input.ttlSeconds ?? DEFAULT_TTL_SECONDS)
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')

  const existing = db.prepare('SELECT * FROM agent_state WHERE agent_id = ?').get(input.agentId) as AgentStateRow | undefined

  if (existing) {
    db.prepare(`
      UPDATE agent_state SET
        agent_type    = COALESCE(@agent_type, agent_type),
        repo          = COALESCE(@repo, repo),
        branch        = COALESCE(@branch, branch),
        intent        = COALESCE(@intent, intent),
        files_touched = COALESCE(@files_touched, files_touched),
        ticket        = COALESCE(@ticket, ticket),
        status        = COALESCE(@status, status),
        expires_at    = @expires_at,
        updated_at    = datetime('now'),
        metadata      = COALESCE(@metadata, metadata)
      WHERE agent_id = @agent_id
    `).run({
      agent_id: input.agentId,
      agent_type: input.agentType ?? null,
      repo: input.repo ?? null,
      branch: input.branch ?? null,
      intent: input.intent ?? null,
      files_touched: input.filesTouched ? JSON.stringify(input.filesTouched) : null,
      ticket: input.ticket ?? null,
      status: input.status ?? null,
      expires_at: expiresAt,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    })
  } else {
    db.prepare(`
      INSERT INTO agent_state
        (agent_id, agent_type, repo, branch, intent, files_touched, ticket, status, expires_at, metadata)
      VALUES
        (@agent_id, @agent_type, @repo, @branch, @intent, @files_touched, @ticket, @status, @expires_at, @metadata)
    `).run({
      agent_id: input.agentId,
      agent_type: input.agentType ?? 'unknown',
      repo: input.repo ?? null,
      branch: input.branch ?? null,
      intent: input.intent ?? null,
      files_touched: input.filesTouched ? JSON.stringify(input.filesTouched) : null,
      ticket: input.ticket ?? null,
      status: input.status ?? null,
      expires_at: expiresAt,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    })
  }

  const row = db.prepare('SELECT * FROM agent_state WHERE agent_id = ?').get(input.agentId) as AgentStateRow
  return rowToState(row)
}

export interface ListStateFilter {
  repo?: string
  ticket?: string
  includeExpired?: boolean
}

export function listAgentState(filter: ListStateFilter = {}): AgentState[] {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (!filter.includeExpired) {
    where.push("expires_at > datetime('now')")
  }
  if (filter.repo) {
    where.push("repo = @repo")
    params.repo = filter.repo
  }
  if (filter.ticket) {
    where.push("ticket = @ticket")
    params.ticket = filter.ticket
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM agent_state ${clause} ORDER BY updated_at DESC`).all(params) as AgentStateRow[]
  return rows.map(rowToState)
}

export function deleteAgentState(agentId: string): boolean {
  const info = db.prepare('DELETE FROM agent_state WHERE agent_id = ?').run(agentId)
  return info.changes > 0
}

// Sweeper: drop rows expired more than 7 days ago so the table stays bounded.
export function gcAgentState(): number {
  const info = db.prepare("DELETE FROM agent_state WHERE expires_at < datetime('now', '-7 days')").run()
  return info.changes
}

// ---- append / read agent_events --------------------------------------------

export interface EventInput {
  eventType: string
  repo?: string | null
  ticket?: string | null
  prNumber?: number | null
  agentId?: string | null
  details?: Record<string, unknown> | null
}

export function insertEvent(input: EventInput): AgentEvent {
  const info = db.prepare(`
    INSERT INTO agent_events (event_type, repo, ticket, pr_number, agent_id, details)
    VALUES (@event_type, @repo, @ticket, @pr_number, @agent_id, @details)
  `).run({
    event_type: input.eventType,
    repo: input.repo ?? null,
    ticket: input.ticket ?? null,
    pr_number: input.prNumber ?? null,
    agent_id: input.agentId ?? null,
    details: input.details ? JSON.stringify(input.details) : null,
  })
  const row = db.prepare('SELECT * FROM agent_events WHERE id = ?').get(info.lastInsertRowid) as AgentEventRow
  return rowToEvent(row)
}

export interface ListEventsFilter {
  since?: string        // ISO timestamp lower bound
  repo?: string
  ticket?: string
  eventType?: string
  limit?: number
}

export function listEvents(filter: ListEventsFilter = {}): AgentEvent[] {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (filter.since) {
    where.push("created_at >= @since")
    params.since = filter.since
  }
  if (filter.repo) {
    where.push("repo = @repo")
    params.repo = filter.repo
  }
  if (filter.ticket) {
    where.push("ticket = @ticket")
    params.ticket = filter.ticket
  }
  if (filter.eventType) {
    where.push("event_type = @event_type")
    params.event_type = filter.eventType
  }
  const limit = Math.min(Math.max(1, filter.limit ?? 100), 1000)
  params.limit = limit
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM agent_events ${clause} ORDER BY created_at DESC LIMIT @limit`).all(params) as AgentEventRow[]
  return rows.map(rowToEvent)
}

// Sweeper: keep 30 days of events.
export function gcAgentEvents(): number {
  const info = db.prepare("DELETE FROM agent_events WHERE created_at < datetime('now', '-30 days')").run()
  return info.changes
}
