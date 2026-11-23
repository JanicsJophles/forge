import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userInfo } from 'node:os'

// config.ts reads env at import time and requires ALLOWED_REPO_PATHS. Point
// READONLY_RUN_USER at the current (real, non-root in CI) account so getCapabilities
// is deterministic; the per-name logic is exercised via readOnlyIdentityFor.
//
// The writable run users must RESOLVE and be DISTINCT from the read-only account:
// under the fail-closed isolation model (finding H) a writable run user that does not
// resolve is treated as a potential collision and refuses read-only. `nobody` and
// `daemon` are standard, resolvable, non-root system accounts whose uid/gid differ
// from any normal interactive/CI user — so the read-only account (= me) is provably
// isolated from them.
const me = userInfo().username
process.env.ALLOWED_REPO_PATHS ??= '/tmp'
process.env.READONLY_RUN_USER = me
process.env.CLAUDE_RUN_USER = 'nobody'
process.env.CODEX_RUN_USER = 'daemon'

const { getCapabilities, resolveReadOnlyIdentity, readOnlyIdentityFor, readOnlyIsIsolated } =
  await import('./capabilities.js')

const info = userInfo()
const isRoot = info.uid === 0
// Guard the getCapabilities assertions: they only hold when the current account does
// not itself collide (uid or gid) with the writable sentinels above.
const meCollides = [65534, 1].includes(info.uid) || [65534, 1].includes(info.gid)

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
  assert.equal(caps.readOnly, resolveReadOnlyIdentity() !== null)
  if (isRoot || meCollides) assert.equal(caps.readOnly, false)
})

// Finding H / 10: a read-only account is only isolated when BOTH its uid and gid are
// non-root AND neither collides with any writable run account's uid OR gid. A shared
// uid OR gid would let a read-only task reach the writable account's repos / credentials
// (group-readable too). Unresolved writable accounts fail CLOSED.
test('readOnlyIsIsolated fails closed on uid/gid 0, a collision, or an unresolved run user', () => {
  // Non-root, no uid/gid collision → isolated.
  assert.equal(
    readOnlyIsIsolated({ uid: 1001, gid: 1001 }, [{ uid: 1002, gid: 1002 }, { uid: 1003, gid: 1003 }]),
    true,
  )
  // Unresolved writable run user (getent failed) → cannot prove distinctness → NOT isolated.
  assert.equal(
    readOnlyIsIsolated({ uid: 1001, gid: 1001 }, [null, { uid: 1003, gid: 1003 }]),
    false,
    'an unresolved run user is treated as a potential collision (fail closed)',
  )
  // Root uid / gid is never isolated.
  assert.equal(readOnlyIsIsolated({ uid: 0, gid: 1001 }, [{ uid: 1002, gid: 1002 }]), false, 'root uid')
  assert.equal(readOnlyIsIsolated({ uid: 1001, gid: 0 }, [{ uid: 1002, gid: 1002 }]), false, 'root gid')
  // Collides with a writable run account on uid.
  assert.equal(
    readOnlyIsIsolated({ uid: 1002, gid: 9999 }, [{ uid: 1002, gid: 1002 }, { uid: 1003, gid: 1003 }]),
    false,
    'same uid as claude run user',
  )
  // Collides with a writable run account on GID only (group-readable credentials leak).
  assert.equal(
    readOnlyIsIsolated({ uid: 9999, gid: 1003 }, [{ uid: 1002, gid: 1002 }, { uid: 1003, gid: 1003 }]),
    false,
    'same gid as codex run user',
  )
})
