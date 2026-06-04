// ---------------------------------------------------------------------------
// candidates: the stuckpoint-capture sink (RAC-378, flywheel 1/4).
// ---------------------------------------------------------------------------
// Sits BESIDE agent_state / agent_events on the same SQLite DB. A `candidate`
// is a raw, un-promoted lesson (symptom → cause → fix → verified-command)
// emitted by the testing-loop (forge + local agent runs) and, later, the
// web-harvest worker (RAC-379). The promotion gate (RAC-380) reads pending
// (`status = 'new'`) candidates and folds the survivors into the skills RAG.
//
// Append-only with a GC sweep, mirroring agent_events. Capture is allowed to
// be noisy — the quality bar is the gate, not this table.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import type {
  Candidate,
  CandidateInput,
  CandidateSource,
  CandidateSeverity,
  CandidateStatus,
  CandidateDeadEnd,
  CandidateReproduction,
  CandidateCommandRecheck,
} from '@forge/shared'
import { db } from './schema.js'

// ---- schema bootstrap ------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS candidates (
    candidate_id     TEXT PRIMARY KEY,
    source           TEXT NOT NULL,
    origin_agent_id  TEXT,
    origin_repo      TEXT,
    origin_ticket    TEXT,
    captured_at      TEXT NOT NULL DEFAULT (datetime('now')),
    proposed_cluster TEXT,
    symptom          TEXT NOT NULL,
    cause            TEXT NOT NULL,
    diagnostic_steps TEXT,
    fix              TEXT NOT NULL,
    severity         TEXT NOT NULL DEFAULT 'medium',
    verified_command TEXT,
    dead_ends        TEXT,
    reproduction     TEXT,
    raw_evidence     TEXT,
    status           TEXT NOT NULL DEFAULT 'new',
    grounding_sources TEXT,
    confidence       TEXT,
    niche_level      TEXT,
    mechanism_verified INTEGER,
    command_recheck  TEXT
  );
  CREATE INDEX IF NOT EXISTS candidates_status_idx   ON candidates(status);
  CREATE INDEX IF NOT EXISTS candidates_source_idx   ON candidates(source);
  CREATE INDEX IF NOT EXISTS candidates_captured_idx ON candidates(captured_at DESC);
  CREATE INDEX IF NOT EXISTS candidates_repo_idx     ON candidates(origin_repo);
`)

// ---- row mapping -----------------------------------------------------------

interface CandidateRow {
  candidate_id: string
  source: string
  origin_agent_id: string | null
  origin_repo: string | null
  origin_ticket: string | null
  captured_at: string
  proposed_cluster: string | null
  symptom: string
  cause: string
  diagnostic_steps: string | null
  fix: string
  severity: string
  verified_command: string | null
  dead_ends: string | null
  reproduction: string | null
  raw_evidence: string | null
  status: string
  grounding_sources: string | null
  confidence: string | null
  niche_level: string | null
  mechanism_verified: number | null
  command_recheck: string | null
}

function parseJson<T>(v: string | null, fallback: T): T {
  if (v == null) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

function rowToCandidate(row: CandidateRow): Candidate {
  return {
    candidateId: row.candidate_id,
    source: row.source as CandidateSource,
    originAgentId: row.origin_agent_id ?? undefined,
    originRepo: row.origin_repo ?? undefined,
    originTicket: row.origin_ticket ?? undefined,
    capturedAt: row.captured_at,
    proposedCluster: row.proposed_cluster ?? undefined,
    symptom: row.symptom,
    cause: row.cause,
    diagnosticSteps: parseJson<string[]>(row.diagnostic_steps, []),
    fix: row.fix,
    severity: row.severity as CandidateSeverity,
    verifiedCommand: row.verified_command ?? undefined,
    deadEnds: parseJson<CandidateDeadEnd[]>(row.dead_ends, []),
    reproduction: parseJson<CandidateReproduction>(row.reproduction, {
      steps: [],
      reproducedOnRealInfra: false,
    }),
    rawEvidence: row.raw_evidence ?? '',
    status: row.status as CandidateStatus,
    groundingSources: row.grounding_sources
      ? parseJson<string[]>(row.grounding_sources, [])
      : undefined,
    confidence: (row.confidence as 'high' | 'medium' | null) ?? undefined,
    nicheLevel: row.niche_level ?? undefined,
    mechanismVerified:
      row.mechanism_verified == null ? undefined : row.mechanism_verified === 1,
    commandRecheck: row.command_recheck
      ? parseJson<CandidateCommandRecheck>(row.command_recheck, undefined as never)
      : undefined,
  }
}

const VALID_SEVERITIES: CandidateSeverity[] = ['low', 'medium', 'high', 'critical']

// ---- insert ----------------------------------------------------------------

export function insertCandidate(input: CandidateInput): Candidate {
  const candidateId = input.candidateId ?? randomUUID()
  const severity: CandidateSeverity = VALID_SEVERITIES.includes(input.severity as CandidateSeverity)
    ? (input.severity as CandidateSeverity)
    : 'medium'
  const reproduction: CandidateReproduction = input.reproduction ?? {
    steps: [],
    reproducedOnRealInfra: false,
  }

  db.prepare(
    `
    INSERT INTO candidates (
      candidate_id, source, origin_agent_id, origin_repo, origin_ticket,
      captured_at, proposed_cluster, symptom, cause, diagnostic_steps, fix,
      severity, verified_command, dead_ends, reproduction, raw_evidence, status,
      grounding_sources, confidence, niche_level, mechanism_verified, command_recheck
    ) VALUES (
      @candidate_id, @source, @origin_agent_id, @origin_repo, @origin_ticket,
      COALESCE(@captured_at, datetime('now')), @proposed_cluster, @symptom, @cause,
      @diagnostic_steps, @fix, @severity, @verified_command, @dead_ends, @reproduction,
      @raw_evidence, @status, @grounding_sources, @confidence, @niche_level,
      @mechanism_verified, @command_recheck
    )
  `,
  ).run({
    candidate_id: candidateId,
    source: input.source,
    origin_agent_id: input.originAgentId ?? null,
    origin_repo: input.originRepo ?? null,
    origin_ticket: input.originTicket ?? null,
    captured_at: input.capturedAt ?? null,
    proposed_cluster: input.proposedCluster ?? null,
    symptom: input.symptom,
    cause: input.cause,
    diagnostic_steps: JSON.stringify(input.diagnosticSteps ?? []),
    fix: input.fix,
    severity,
    verified_command: input.verifiedCommand ?? null,
    dead_ends: JSON.stringify(input.deadEnds ?? []),
    reproduction: JSON.stringify(reproduction),
    raw_evidence: input.rawEvidence ?? '',
    status: (input.status as CandidateStatus) ?? 'new',
    grounding_sources: input.groundingSources ? JSON.stringify(input.groundingSources) : null,
    confidence: input.confidence ?? null,
    niche_level: input.nicheLevel ?? null,
    mechanism_verified:
      input.mechanismVerified == null ? null : input.mechanismVerified ? 1 : 0,
    command_recheck: input.commandRecheck ? JSON.stringify(input.commandRecheck) : null,
  })

  const row = db
    .prepare('SELECT * FROM candidates WHERE candidate_id = ?')
    .get(candidateId) as CandidateRow
  return rowToCandidate(row)
}

// ---- read ------------------------------------------------------------------

export interface ListCandidatesFilter {
  status?: CandidateStatus
  source?: CandidateSource
  repo?: string
  limit?: number
}

export function listCandidates(filter: ListCandidatesFilter = {}): Candidate[] {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (filter.status) {
    where.push('status = @status')
    params.status = filter.status
  }
  if (filter.source) {
    where.push('source = @source')
    params.source = filter.source
  }
  if (filter.repo) {
    where.push('origin_repo = @repo')
    params.repo = filter.repo
  }
  const limit = Math.min(Math.max(1, filter.limit ?? 100), 1000)
  params.limit = limit
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT * FROM candidates ${clause} ORDER BY captured_at DESC LIMIT @limit`)
    .all(params) as CandidateRow[]
  return rows.map(rowToCandidate)
}

export function getCandidate(candidateId: string): Candidate | null {
  const row = db
    .prepare('SELECT * FROM candidates WHERE candidate_id = ?')
    .get(candidateId) as CandidateRow | undefined
  return row ? rowToCandidate(row) : null
}

// Sweeper: drop promoted/rejected candidates older than 30 days. Pending
// ('new'/'queued') candidates are never auto-collected — they are unprocessed
// work for the gate.
export function gcCandidates(): number {
  const info = db
    .prepare(
      `DELETE FROM candidates
       WHERE status IN ('promoted', 'rejected')
         AND captured_at < datetime('now', '-30 days')`,
    )
    .run()
  return info.changes
}
