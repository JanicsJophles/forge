import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userInfo } from 'node:os'

// config.ts reads env at import time and requires ALLOWED_REPO_PATHS. Point
// READONLY_RUN_USER at the current (real, non-root in CI) account so getCapabilities
// is deterministic; the per-name logic is exercised via readOnlyIdentityFor.
const me = userInfo().username
process.env.ALLOWED_REPO_PATHS ??= '/tmp'
process.env.READONLY_RUN_USER = me

const { getCapabilities, resolveReadOnlyIdentity, readOnlyIdentityFor } = await import('./capabilities.js')

const isRoot = userInfo().uid === 0

test('read-only account is null when no name is configured', () => {
  assert.equal(readOnlyIdentityFor(undefined), null)
  assert.equal(readOnlyIdentityFor(''), null)
})

test('read-only account is null when the account does not exist', () => {
  assert.equal(readOnlyIdentityFor('definitely-not-a-real-account-xyz'), null)
})

test('read-only account resolves for a real, non-root account', () => {
  if (isRoot) {
    // executionIdentity refuses uid 0; root cannot be a run account.
    assert.equal(readOnlyIdentityFor(me), null)
  } else {
    const id = readOnlyIdentityFor(me)
    assert.notEqual(id, null)
    assert.equal(id!.username, me)
    assert.notEqual(id!.uid, 0)
  }
})

test('getCapabilities reflects the configured account and provider contract', () => {
  const caps = getCapabilities()
  assert.equal(caps.providerSelectionVersion, 1)
  assert.deepEqual(caps.providers, ['claude', 'codex'])
  assert.equal(caps.readOnly, !isRoot)
  // resolveReadOnlyIdentity uses the configured name (READONLY_RUN_USER = me).
  assert.equal(resolveReadOnlyIdentity() === null, isRoot)
})
