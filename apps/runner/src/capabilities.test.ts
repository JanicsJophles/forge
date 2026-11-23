import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userInfo } from 'node:os'

// config.ts reads env at import time and requires ALLOWED_REPO_PATHS. Point
// READONLY_RUN_USER at the current (real, non-root in CI) account so getCapabilities
// is deterministic; the per-name logic is exercised via readOnlyIdentityFor. The
// writable run users are set to sentinels that do NOT resolve, so the read-only
// account's uid cannot collide with them (which would otherwise fail closed — the
// current user is typically the default `forge`/CI run user).
const me = userInfo().username
process.env.ALLOWED_REPO_PATHS ??= '/tmp'
process.env.READONLY_RUN_USER = me
process.env.CLAUDE_RUN_USER = 'definitely-not-a-real-run-user-aaa'
process.env.CODEX_RUN_USER = 'definitely-not-a-real-run-user-bbb'

const { getCapabilities, resolveReadOnlyIdentity, readOnlyIdentityFor, readOnlyIsIsolated } =
  await import('./capabilities.js')

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

// Finding 10: a read-only account is only isolated when its uid is non-root AND does
// not collide with any writable run account's uid. A shared uid would let a read-only
// task reach the writable account's repos / credentials.
test('readOnlyIsIsolated fails closed on uid 0 or a run-user collision', () => {
  // Non-root, no collision → isolated.
  assert.equal(readOnlyIsIsolated(1001, [1002, 1003]), true)
  assert.equal(readOnlyIsIsolated(1001, [null, null]), true, 'unresolved run users do not collide')
  // Root is never isolated.
  assert.equal(readOnlyIsIsolated(0, [1002, 1003]), false)
  // Collides with a writable run account.
  assert.equal(readOnlyIsIsolated(1002, [1002, 1003]), false, 'same uid as claude run user')
  assert.equal(readOnlyIsIsolated(1003, [1002, 1003]), false, 'same uid as codex run user')
})
