import assert from 'node:assert/strict'
import { test } from 'node:test'

import { exitReason } from './exit-reason.js'

test('exitReason reports the signal when a task is killed (code null + signal)', () => {
  assert.equal(exitReason('claude', null, 'SIGTERM'), 'claude terminated by SIGTERM')
  assert.equal(exitReason('codex', null, 'SIGKILL'), 'codex terminated by SIGKILL')
})

test('exitReason reports the exit code on a normal non-zero exit', () => {
  assert.equal(exitReason('claude', 1, null), 'claude exited with code 1')
  assert.equal(exitReason('codex', 127, null), 'codex exited with code 127')
})

test('exitReason falls back to the exit code when code is null but no signal is present', () => {
  assert.equal(exitReason('claude', null, null), 'claude exited with code null')
})
