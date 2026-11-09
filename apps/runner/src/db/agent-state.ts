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

// Nullable fields use patch semantics: undefined retains, null clears, values replace.
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

// Bounds so one runaway agent can't bloat the board (re-served in every
// /agent-context for the checkpoint's TTL). The 2mb body cap is the only
// other guard. Patch semantics are preserved: undefined/null pass through
// untouched; only actual string/array values are capped.
const MAX_FIELD_CHARS = 500
const MAX_FILES_TOUCHED = 200

function capField<T extends string | null | undefined>(v: T): T {
  if (typeof v !== 'string' || v.length <= MAX_FIELD_CHARS) return v
  return v.slice(0, MAX_FIELD_CHARS) as T
}

function capFilesTouched<T extends string[] | null | undefined>(v: T): T {
  if (!Array.isArray(v)) return v
  return v.slice(0, MAX_FILES_TOUCHED).map(capField) as T
}

export function checkpoint(input: CheckpointInput): AgentState {
  const requestedTtl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const ttl = Number.isFinite(requestedTtl)
    ? Math.min(604800, Math.max(60, Math.floor(requestedTtl)))
    : DEFAULT_TTL_SECONDS
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')

  // Bound each stored field up front so both the insert and update paths persist
  // the capped values (and the set_* patch flags still key off the originals).
  const agentType = capField(input.agentType)
  const repo = capField(input.repo)
  const branch = capField(input.branch)
  const intent = capField(input.intent)
  const ticket = capField(input.ticket)
  const status = capField(input.status)
  const filesTouched = capFilesTouched(input.filesTouched)

  const existing = db.prepare('SELECT * FROM agent_state WHERE agent_id = ?').get(input.agentId) as AgentStateRow | undefined

  if (existing) {
    db.prepare(`
      UPDATE agent_state SET
        agent_type    = COALESCE(@agent_type, agent_type),
        repo          = CASE WHEN @set_repo THEN @repo ELSE repo END,
        branch        = CASE WHEN @set_branch THEN @branch ELSE branch END,
        intent        = CASE WHEN @set_intent THEN @intent ELSE intent END,
        files_touched = CASE WHEN @set_files_touched THEN @files_touched ELSE files_touched END,
        ticket        = CASE WHEN @set_ticket THEN @ticket ELSE ticket END,
        status        = CASE WHEN @set_status THEN @status ELSE status END,
        expires_at    = @expires_at,
        updated_at    = datetime('now'),
        metadata      = CASE WHEN @set_metadata THEN @metadata ELSE metadata END
      WHERE agent_id = @agent_id
    `).run({
      agent_id: input.agentId,
      agent_type: agentType ?? null,
      set_repo: Number(input.repo !== undefined),
      set_branch: Number(input.branch !== undefined),
      set_intent: Number(input.intent !== undefined),
      set_files_touched: Number(input.filesTouched !== undefined),
      set_ticket: Number(input.ticket !== undefined),
      set_status: Number(input.status !== undefined),
      set_metadata: Number(input.metadata !== undefined),
      repo: repo ?? null,
      branch: branch ?? null,
      intent: intent ?? null,
      files_touched: filesTouched ? JSON.stringify(filesTouched) : null,
      ticket: ticket ?? null,
      status: status ?? null,
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
      agent_type: agentType ?? 'unknown',
      repo: repo ?? null,
      branch: branch ?? null,
      intent: intent ?? null,
      files_touched: filesTouched ? JSON.stringify(filesTouched) : null,
      ticket: ticket ?? null,
      status: status ?? null,
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
  agentId?: string      // Exact identity, applied before the bounded window
  afterId?: number     // Exclusive event ID cursor; oldest unseen events first
  since?: string        // Inclusive ISO or SQLite UTC timestamp; invalid nonempty values match nothing
  repo?: string
  ticket?: string
  eventType?: string
  limit?: number
}

export function listEvents(filter: ListEventsFilter = {}): AgentEvent[] {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (filter.agentId !== undefined) {
    where.push("agent_id = @agent_id")
    params.agent_id = filter.agentId
  }
  if (filter.afterId !== undefined) {
    where.push("id > @after_id")
    params.after_id = filter.afterId
  }
  if (filter.since) {
    // Normalize the bound only, keeping the created_at index usable. SQLite
    // handles Z/offsets and returns NULL for unparseable timestamps (no matches).
    // Trim fractional zeroes so an exact second remains inclusive while a
    // fractional bound still excludes events earlier within that second.
    where.push("created_at >= rtrim(rtrim(strftime('%Y-%m-%d %H:%M:%f', @since), '0'), '.')")
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
  const order = filter.afterId !== undefined ? 'id ASC' : 'created_at DESC, id DESC'
  const rows = db.prepare(`SELECT * FROM agent_events ${clause} ORDER BY ${order} LIMIT @limit`).all(params) as AgentEventRow[]
  return rows.map(rowToEvent)
}

// Sweeper: keep 30 days of events.
export function gcAgentEvents(): number {
  const info = db.prepare("DELETE FROM agent_events WHERE created_at < datetime('now', '-30 days')").run()
  return info.changes
}
