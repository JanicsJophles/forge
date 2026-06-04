import { describe, it, expect } from 'vitest'
import { detectFailureSignals, extractCandidates } from './extractor.js'

// A realistic stuckpoint transcript: a command fails, the agent tries a
// dead-end, realizes it's wrong, then finds the working command.
const STUCKPOINT_LOG = `
[forge] starting claude agent in /srv/repos/rackmind-macos
$ tar -czf bundle.tar.gz ./dist
$ unzip bundle.tar.gz
Error: End-of-central-directory signature not found
$ tar -czf bundle.tar.gz ./dist
that didn't work — the archive has ._ AppleDouble files polluting it
actually the issue is macOS bsdtar writing AppleDouble metadata
$ COPYFILE_DISABLE=1 tar --no-xattrs -czf bundle.tar.gz ./dist
working now — the Java zip reader on Linux accepts it
[forge] claude exited with code 0
`.trim()

// A trivial transcript: everything succeeds, no failure signals at all.
const TRIVIAL_LOG = `
[forge] starting claude agent in /srv/repos/rackmind-frontend
$ npm run build
Compiled successfully.
$ git status
nothing to commit, working tree clean
[forge] claude exited with code 0
`.trim()

describe('detectFailureSignals (heuristic prefilter)', () => {
  it('flags a stuckpoint transcript as having signal', () => {
    const s = detectFailureSignals(STUCKPOINT_LOG)
    expect(s.hasSignal).toBe(true)
    expect(s.errorLines.length).toBeGreaterThan(0)
    expect(s.recoveryPhrases.length).toBeGreaterThan(0)
    // the failing tar command was retried
    expect(s.retriedCommands.some((c) => c.includes('tar -czf bundle.tar.gz'))).toBe(true)
  })

  it('reports NO signal for a trivial transcript', () => {
    const s = detectFailureSignals(TRIVIAL_LOG)
    expect(s.hasSignal).toBe(false)
    expect(s.errorLines).toHaveLength(0)
    expect(s.recoveryPhrases).toHaveLength(0)
    expect(s.retriedCommands).toHaveLength(0)
  })
})

describe('extractCandidates', () => {
  it('emits ≥1 candidate with a verifiedCommand for a stuckpoint transcript', () => {
    const candidates = extractCandidates(STUCKPOINT_LOG, {
      source: 'testing-loop',
      originAgentId: 'forge-task-abc123',
      originRepo: '/srv/repos/rackmind-macos',
    })
    expect(candidates.length).toBeGreaterThanOrEqual(1)

    const c = candidates[0]
    expect(c.source).toBe('testing-loop')
    expect(c.originAgentId).toBe('forge-task-abc123')
    expect(c.symptom).toBeTruthy()
    expect(c.cause).toBeTruthy()
    expect(c.fix).toBeTruthy()
    // a command was the fix, so verifiedCommand must be populated
    expect(c.verifiedCommand).toBeTruthy()
    // testing-loop runs on real infra
    expect(c.reproduction.reproducedOnRealInfra).toBe(true)
  })

  it('captures dead-ends / confident-wrong turns, not just the winning leaf', () => {
    const [c] = extractCandidates(STUCKPOINT_LOG)
    expect(c.deadEnds && c.deadEnds.length).toBeGreaterThan(0)
    // the retried failing command and/or the "that didn't work" turn show up
    const joined = JSON.stringify(c.deadEnds)
    expect(joined.includes('tar') || joined.toLowerCase().includes("didn't work")).toBe(true)
  })

  it('emits ZERO candidates for a trivial transcript (prefilter suppresses cost)', () => {
    expect(extractCandidates(TRIVIAL_LOG)).toHaveLength(0)
    expect(extractCandidates('')).toHaveLength(0)
    expect(extractCandidates('hello world\nall good')).toHaveLength(0)
  })

  it('escalates severity when an exit code coincides with a recovery', () => {
    const [c] = extractCandidates(STUCKPOINT_LOG)
    expect(['medium', 'high', 'critical']).toContain(c.severity)
  })
})
