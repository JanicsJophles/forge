import assert from 'node:assert/strict'
import { test } from 'node:test'

import { exitReason } from './exit-reason.js'

test('exitReason hints at a cancel or shutdown when killed by SIGTERM', () => {
  assert.equal(
    exitReason('claude', null, 'SIGTERM'),
    'claude terminated by SIGTERM (cancelled or shutting down)'
  )
})

test('exitReason hints at a timeout or force-kill when killed by SIGKILL', () => {
  assert.equal(
    exitReason('codex', null, 'SIGKILL'),
    'codex terminated by SIGKILL (timed out or force-killed)'
  )
})

test('exitReason appends a generic error hint on a normal non-zero exit', () => {
  assert.equal(
    exitReason('claude', 1, null),
    'claude exited with code 1 (agent reported an error — see the task log)'
  )
  assert.equal(
    exitReason('codex', 127, null),
    'codex exited with code 127 (agent reported an error — see the task log)'
  )
})

test('exitReason keeps the plain form for an unrecognized signal', () => {
  assert.equal(exitReason('claude', null, 'SIGINT'), 'claude terminated by SIGINT')
})

test('exitReason falls back to the exit code when code is null but no signal is present', () => {
  assert.equal(exitReason('claude', null, null), 'claude exited with code null')
})
