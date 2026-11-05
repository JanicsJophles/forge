import assert from 'node:assert/strict'
import { test } from 'node:test'

import { providerCommand } from './provider.js'

test('providerCommand appends --model for claude only when a model is set', () => {
  assert.deepEqual(providerCommand('claude', 'claude-haiku-4-5'), {
    command: 'claude',
    args: ['--dangerously-skip-permissions', '--model', 'claude-haiku-4-5', '-p'],
  })
})

test('providerCommand appends -m for codex only when a model is set', () => {
  assert.deepEqual(providerCommand('codex', 'gpt-5-codex'), {
    command: 'codex',
    args: ['exec', '--sandbox', 'workspace-write', '-m', 'gpt-5-codex', '-'],
  })
})

test('providerCommand preserves the default args when no model is supplied', () => {
  assert.deepEqual(providerCommand('claude'), {
    command: 'claude',
    args: ['--dangerously-skip-permissions', '-p'],
  })
  assert.deepEqual(providerCommand('codex'), {
    command: 'codex',
    args: ['exec', '--sandbox', 'workspace-write', '-'],
  })
})

test('providerCommand keeps the model as a single separate argv token', () => {
  // A model with hyphens and dots must never be split or shell-interpolated.
  const { args } = providerCommand('claude', 'claude-opus-4.6')
  assert.ok(args.includes('claude-opus-4.6'))
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-4.6')
})
