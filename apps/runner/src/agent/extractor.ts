// ---------------------------------------------------------------------------
// extractor: turn an agent transcript/log into stuckpoint Candidate(s).
// (RAC-378, flywheel 1/4)
// ---------------------------------------------------------------------------
// Two stages, designed for NEAR-ZERO marginal cost:
//
//   1. heuristic prefilter (`detectFailureSignals`) — cheap, no network. Only
//      if the log shows real failure signals (non-zero exits, retried
//      commands, error strings, "that didn't work / actually the issue is"
//      patterns) do we go further. A trivial, no-stuckpoint log produces ZERO
//      candidates here and the (paid) LLM pass is never invoked.
//
//   2. extraction — `extractCandidates` builds a structured Candidate from the
//      detected signals. This module ships a deterministic heuristic
//      extractor so the hook works with NO API key and NO network. A richer
//      LLM pass (Haiku-class) can be layered on top via `llmExtract`, but it
//      is OPT-IN (only invoked when signals are present AND a key is set), so
//      the default cost is zero.
//
// The standing rule applies: capture the FULL route including dead-ends +
// confident-wrong turns, not just the winning leaf.
// ---------------------------------------------------------------------------

import type {
  CandidateInput,
  CandidateSource,
  CandidateSeverity,
  CandidateDeadEnd,
} from '@forge/shared'

// ---- 1. heuristic prefilter ------------------------------------------------

export interface FailureSignals {
  hasSignal: boolean
  nonZeroExits: number[]          // exit codes seen in the log (>0)
  errorLines: string[]            // lines that look like errors
  retriedCommands: string[]       // commands that appear ≥2x (retry pattern)
  recoveryPhrases: string[]       // "that didn't work / actually the issue is" cues
  fixLines: string[]              // lines that look like the resolving action
  commandLines: string[]          // shell-ish command lines (for verifiedCommand)
}

// Phrases that signal a recovery / confident-wrong turn — the heart of a
// stuckpoint. Lower-cased match.
const RECOVERY_PATTERNS: RegExp[] = [
  /that did(?:n't| not) work/,
  /actually,? the (?:real )?(?:issue|problem|cause|fix) (?:is|was)/,
  /turns out/,
  /the (?:real|actual) (?:issue|problem|root cause)/,
  /\bred herring\b/,
  /\bI was wrong\b/,
  /instead,? (?:I|we|you) (?:need|needed|should|had to)/,
  /\bfixed (?:it|by)\b/,
  /\bresolved by\b/,
  /\bthe fix (?:is|was)\b/,
  /\bnow it works\b/,
  /\bworking now\b/,
]

// Generic error cues. Kept conservative to avoid false positives on benign
// output that merely contains the word "error".
const ERROR_PATTERNS: RegExp[] = [
  /\berror\b[:\s]/i,
  /\bfailed\b/i,
  /\bfatal\b/i,
  /\bexception\b/i,
  /\bcommand not found\b/i,
  /\bpermission denied\b/i,
  /\bno such file\b/i,
  /\bconnection refused\b/i,
  /\btimed? out\b/i,
  /\bcannot find\b/i,
  /\btraceback\b/i,
  /\bsegmentation fault\b/i,
  /exited? with (?:code|status) [1-9]/i,
  /\bnon-zero exit\b/i,
]

const EXIT_CODE_PATTERN = /exit(?:ed)?(?: with)?(?: code| status)?\s+([0-9]{1,3})/gi

// Lines that look like a shell command (heuristic): a leading `$ ` or a
// recognizable binary at the start.
const COMMAND_LINE_PATTERN =
  /^\s*\$?\s*((?:sudo |COPYFILE_DISABLE=\S+ )?(?:npm|pnpm|yarn|git|docker|pct|ssh|systemctl|tailscale|curl|node|tsc|make|apt|apt-get|kubectl|nginx|qm|zfs|ufw|ip|tar|rsync|ln|chmod|chown|cp|mv|mkdir|cat|sed)\b.*)$/

function isCommandLine(line: string): string | null {
  const m = line.match(COMMAND_LINE_PATTERN)
  return m ? m[1].trim() : null
}

export function detectFailureSignals(log: string): FailureSignals {
  const lines = log.split(/\r?\n/)
  const nonZeroExits: number[] = []
  const errorLines: string[] = []
  const recoveryPhrases: string[] = []
  const fixLines: string[] = []
  const commandLines: string[] = []
  const commandCounts = new Map<string, number>()

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const lower = line.toLowerCase()

    // exit codes
    let m: RegExpExecArray | null
    EXIT_CODE_PATTERN.lastIndex = 0
    while ((m = EXIT_CODE_PATTERN.exec(line)) !== null) {
      const code = parseInt(m[1], 10)
      if (code > 0) nonZeroExits.push(code)
    }

    // errors
    if (ERROR_PATTERNS.some((re) => re.test(line))) {
      errorLines.push(line)
    }

    // recovery / confident-wrong cues
    if (RECOVERY_PATTERNS.some((re) => re.test(lower))) {
      recoveryPhrases.push(line)
      // a recovery phrase line frequently also states the fix
      fixLines.push(line)
    }

    // commands (for retry detection + verifiedCommand)
    const cmd = isCommandLine(line)
    if (cmd) {
      commandLines.push(cmd)
      commandCounts.set(cmd, (commandCounts.get(cmd) ?? 0) + 1)
    }
  }

  const retriedCommands = [...commandCounts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([cmd]) => cmd)

  const hasSignal =
    nonZeroExits.length > 0 ||
    errorLines.length > 0 ||
    retriedCommands.length > 0 ||
    recoveryPhrases.length > 0

  return {
    hasSignal,
    nonZeroExits,
    errorLines,
    retriedCommands,
    recoveryPhrases,
    fixLines,
    commandLines,
  }
}

// ---- 2. extraction ---------------------------------------------------------

export interface ExtractOptions {
  source?: CandidateSource
  originAgentId?: string
  originRepo?: string
  originTicket?: string
  host?: string
  // Cap on rawEvidence length so we never ship a multi-MB transcript.
  maxEvidenceChars?: number
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '… [truncated]'
}

function severityFor(signals: FailureSignals): CandidateSeverity {
  if (signals.errorLines.some((l) => /fatal|segmentation fault|critical|data loss/i.test(l))) {
    return 'critical'
  }
  if (signals.nonZeroExits.length > 0 && signals.recoveryPhrases.length > 0) return 'high'
  // An error the agent had to recover from (recovery phrase present) is a real
  // wall, not noise — bump it to medium even without a captured exit code.
  if (signals.errorLines.length > 0 && signals.recoveryPhrases.length > 0) return 'medium'
  if (signals.nonZeroExits.length > 0 || signals.errorLines.length > 1) return 'medium'
  return 'low'
}

// Pick the best "verified command" — prefer a command that was retried (it was
// the one being iterated on) and that appears near a recovery phrase; else the
// last command line seen (most likely the one that finally worked).
function pickVerifiedCommand(signals: FailureSignals): string | undefined {
  if (signals.retriedCommands.length > 0) {
    return signals.retriedCommands[signals.retriedCommands.length - 1]
  }
  if (signals.commandLines.length > 0) {
    return signals.commandLines[signals.commandLines.length - 1]
  }
  return undefined
}

function buildDeadEnds(signals: FailureSignals): CandidateDeadEnd[] {
  const deadEnds: CandidateDeadEnd[] = []
  // Retried-then-abandoned commands are dead-ends; pair each with the nearest
  // error line as the reason it failed.
  const firstError = signals.errorLines[0]
  for (const cmd of signals.retriedCommands) {
    deadEnds.push({
      tried: cmd,
      whyFailed: firstError ?? 'retried without success before the working fix',
    })
  }
  // Explicit confident-wrong turns surfaced by recovery phrases like
  // "that didn't work" / "red herring".
  for (const phrase of signals.recoveryPhrases) {
    if (/that did(?:n't| not) work|red herring|I was wrong/i.test(phrase)) {
      deadEnds.push({ tried: phrase, whyFailed: 'confident-wrong turn (self-corrected later)' })
    }
  }
  return deadEnds
}

/**
 * Heuristic, deterministic extraction. Produces ZERO candidates for a trivial
 * log (no failure signals) and ≥1 structured Candidate when a stuckpoint is
 * detected. No network, no API key — this is the always-on default path.
 */
export function extractCandidates(log: string, opts: ExtractOptions = {}): CandidateInput[] {
  const signals = detectFailureSignals(log)
  if (!signals.hasSignal) return []

  const maxEvidence = opts.maxEvidenceChars ?? 4000
  const symptom =
    signals.errorLines[0] ??
    (signals.nonZeroExits.length
      ? `command exited non-zero (code ${signals.nonZeroExits[0]})`
      : 'agent hit a non-trivial wall during the run')

  const cause =
    signals.recoveryPhrases.find((p) =>
      /actually|the (?:real|actual)|turns out|root cause/i.test(p),
    ) ?? 'root cause not explicitly stated in the transcript — see rawEvidence'

  const fix =
    signals.fixLines[0] ??
    (pickVerifiedCommand(signals)
      ? `applied: ${pickVerifiedCommand(signals)}`
      : 'recovered — see rawEvidence for the resolving action')

  const diagnosticSteps = [
    ...new Set([...signals.errorLines.slice(0, 3), ...signals.recoveryPhrases.slice(0, 3)]),
  ]

  const candidate: CandidateInput = {
    source: opts.source ?? 'testing-loop',
    originAgentId: opts.originAgentId,
    originRepo: opts.originRepo,
    originTicket: opts.originTicket,
    proposedCluster: undefined,
    symptom,
    cause,
    diagnosticSteps,
    fix,
    severity: severityFor(signals),
    verifiedCommand: pickVerifiedCommand(signals),
    deadEnds: buildDeadEnds(signals),
    reproduction: {
      host: opts.host,
      steps: signals.commandLines.slice(0, 10),
      observedExit: signals.nonZeroExits[0],
      // Testing-loop captures run on real infra by definition.
      reproducedOnRealInfra: (opts.source ?? 'testing-loop') === 'testing-loop',
    },
    rawEvidence: clamp(log, maxEvidence),
    status: 'new',
  }

  return [candidate]
}
