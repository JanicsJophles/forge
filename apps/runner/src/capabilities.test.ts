import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runnerCapabilities } from './capabilities.js'

test('capabilities advertises read-only support', () => {
  assert.equal(runnerCapabilities.readOnly, true)
})

test('capabilities still advertises the provider contract', () => {
  assert.equal(runnerCapabilities.providerSelectionVersion, 1)
  assert.deepEqual(runnerCapabilities.providers, ['claude', 'codex'])
})
