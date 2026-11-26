import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StallWatchdog, watchdogLimits, watchdogIntervalMs, invalidWatchdogOverride } from '../src/agent/watchdog.js'

const MIN = 60_000
const limits = { stallMs: 45 * MIN, exitGraceMs: 10 * MIN }

test('an agent that keeps printing is never flagged', () => {
  const w = new StallWatchdog(limits, 0)
  for (let t = 0; t <= 5 * 60 * MIN; t += 10 * MIN) {
    w.output(t)
    assert.equal(w.check(t + 9 * MIN), null)
  }
})

test('no output for the stall limit is a stall', () => {
  const w = new StallWatchdog(limits, 0)
  w.output(MIN)
  assert.equal(w.check(45 * MIN), null)
  const verdict = w.check(46 * MIN)
  assert.equal(verdict?.kind, 'stalled')
  assert.match(verdict?.message ?? '', /no agent output for 45 min/)
})

test('finished but still running after the grace is lingering, long before the stall limit', () => {
  // The 2026-11-25 case: final result printed, then a background `until ...; do sleep 5; done` kept claude alive.
  const w = new StallWatchdog(limits, 0)
  w.output(20 * MIN)
  w.result(20 * MIN)
  assert.equal(w.check(29 * MIN), null)
  assert.equal(w.check(30 * MIN)?.kind, 'lingering')
})

test('output after a result (agent re-invoked by a background task) restarts the grace', () => {
  const w = new StallWatchdog(limits, 0)
  w.result(MIN)
  w.output(8 * MIN)
  assert.equal(w.check(15 * MIN), null)
  w.result(9 * MIN)
  assert.equal(w.check(19 * MIN)?.kind, 'lingering')
})

test('a zero limit turns that check off', () => {
  const w = new StallWatchdog({ stallMs: 0, exitGraceMs: 0 }, 0)
  w.result(0)
  assert.equal(w.check(1000 * MIN), null)
})

test('limits: env defaults, per-task overrides win, interval follows the shortest limit', () => {
  const saved = { ...process.env }
  try {
    delete process.env.TASK_STALL_MINUTES
    delete process.env.TASK_EXIT_GRACE_MINUTES
    assert.deepEqual(watchdogLimits(), { stallMs: 45 * MIN, exitGraceMs: 10 * MIN })
    process.env.TASK_STALL_MINUTES = '5'
    process.env.TASK_EXIT_GRACE_MINUTES = 'nope'
    assert.deepEqual(watchdogLimits(), { stallMs: 5 * MIN, exitGraceMs: 10 * MIN })
    assert.deepEqual(watchdogLimits({ stallMinutes: 120, exitGraceMinutes: 0 }), { stallMs: 120 * MIN, exitGraceMs: 0 })
    assert.deepEqual(watchdogLimits({ exitGraceMinutes: 2 }), { stallMs: 5 * MIN, exitGraceMs: 2 * MIN })
  } finally {
    process.env = saved
  }
  assert.equal(watchdogIntervalMs({ stallMs: 45 * MIN, exitGraceMs: 10 * MIN }), 30_000)
  assert.equal(watchdogIntervalMs({ stallMs: 600, exitGraceMs: 0 }), 200)
  assert.equal(watchdogIntervalMs({ stallMs: 0, exitGraceMs: 0 }), 30_000)
})

test('override validation', () => {
  assert.equal(invalidWatchdogOverride('stallMinutes', undefined), null)
  assert.equal(invalidWatchdogOverride('stallMinutes', 0), null)
  assert.equal(invalidWatchdogOverride('stallMinutes', 90.5), null)
  for (const bad of [-1, '10', Number.NaN, 24 * 60 + 1, null]) {
    assert.match(invalidWatchdogOverride('stallMinutes', bad) ?? '', /stallMinutes must be a number of minutes/)
  }
})
