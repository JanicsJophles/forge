export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface AgentTask {
  id: string
  repo: string
  branch: string
  prompt: string
  status: TaskStatus
  log: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  errorMessage?: string
  commitSha?: string
}

export interface TaskEvent {
  type: 'log' | 'status' | 'complete' | 'error'
  data: string
  timestamp: string
}

export interface RunRequest {
  repo: string          // absolute path on the LXC / local machine
  branch?: string
  prompt: string
  autoCommit?: boolean
}

// ---------------------------------------------------------------------------
// Candidate — a captured stuckpoint lesson (RAC-378, flywheel 1/4).
//
// A `Candidate` is the raw, un-promoted unit produced by the testing-loop
// (forge + local agent runs) and the web-harvest worker (RAC-379). It is a
// SUPERSET of rackmind-server `skill.schema.json`'s `failureMode` so that the
// promotion gate (RAC-380) can map it directly onto a `topFailureModes[]`
// entry inside a `skills/<cluster>.json`:
//
//   symptom         → failureMode.symptom
//   cause           → failureMode.likelyCause
//   diagnosticSteps → failureMode.diagnosticSteps
//   fix             → failureMode.fix
//   severity        → failureMode.severity
//
// Capture is allowed to be NOISY — the quality bar is the RAC-380 gate, not
// this struct. `reproduction.reproducedOnRealInfra: true` is the highest
// verification tier and the gate's auto-promote fast-path.
// ---------------------------------------------------------------------------

export type CandidateSource = 'testing-loop' | 'web-harvest'

export type CandidateSeverity = 'low' | 'medium' | 'high' | 'critical'

// new      → freshly captured, awaiting the gate
// queued   → gate flagged medium-confidence, awaiting human/agent review
// promoted → folded into a skills/<cluster>.json
// rejected → gate discarded (e.g. command-recheck dropped a web finding)
export type CandidateStatus = 'new' | 'queued' | 'promoted' | 'rejected'

// A dead-end / confident-wrong turn. The decision-tree IS the product
// knowledge, not just the leaf that worked — negative results stop the next
// agent (and the RAG) from re-trying a known dead path.
export interface CandidateDeadEnd {
  tried: string       // what was attempted
  whyFailed: string   // why it didn't work (root cause of the dead-end)
}

export interface CandidateReproduction {
  host?: string                     // where it was reproduced (e.g. 'LXC 118')
  steps: string[]                   // ordered steps to reproduce
  observedExit?: number             // observed non-zero exit code, if any
  reproducedOnRealInfra: boolean    // highest verification tier + auto-promote fast-path
}

// Re-verification of a command/version string (web-harvest path, RAC-379).
// `dropped` candidates are never emitted (drop-if-fix-wrong rule).
export interface CandidateCommandRecheck {
  rechecked: boolean
  result: 'confirmed' | 'corrected' | 'dropped'
}

export interface Candidate {
  candidateId: string                 // uuid
  source: CandidateSource             // 'testing-loop' (RAC-378) | 'web-harvest' (RAC-379)
  originAgentId?: string              // local-claude-<8> | forge-task-<uuid>
  originRepo?: string                 // from agent-board context if present
  originTicket?: string               // from agent-board context if present
  capturedAt: string                  // iso8601
  proposedCluster?: string            // best-guess existing skill cluster (e.g. 'docker-in-lxc')

  // --- maps onto skill.schema.json failureMode ---
  symptom: string                     // → failureMode.symptom
  cause: string                       // → failureMode.likelyCause
  diagnosticSteps: string[]           // → failureMode.diagnosticSteps
  fix: string                         // → failureMode.fix
  severity: CandidateSeverity         // → failureMode.severity

  verifiedCommand?: string            // exact command/flag that worked (command-level ground truth)
  deadEnds: CandidateDeadEnd[]        // negative results / confident-wrong turns
  reproduction: CandidateReproduction
  rawEvidence: string                 // log excerpt / transcript pointer (audit trail for the gate)
  status: CandidateStatus             // gate (RAC-380) advances this

  // --- web-harvest-specific (RAC-379); optional for testing-loop ---
  groundingSources?: string[]         // ≥1 primary-source URL (required for web-harvest)
  confidence?: 'high' | 'medium'
  nicheLevel?: string
  mechanismVerified?: boolean
  commandRecheck?: CandidateCommandRecheck
}

// Input accepted by POST /agent-candidates. The route fills candidateId,
// capturedAt, and status='new' when absent.
export interface CandidateInput extends Partial<Omit<Candidate, 'symptom' | 'cause' | 'fix' | 'source'>> {
  source: CandidateSource
  symptom: string
  cause: string
  fix: string
}
