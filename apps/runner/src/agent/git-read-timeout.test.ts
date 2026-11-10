import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { getCurrentBranch, hasUncommittedChanges } from './git.js'

// Replace the native runner, keeping these tests offline and instantaneous even
// for timeout failures. Verify the production timeout and signal at the boundary.
test('read probes use bounded argv-only, noninteractive execution', t => {
  const hostilePath = '/tmp/repo $(touch OWNED); `echo SECRET` " spaced'
  const calls: unknown[][] = []
  const results = [' refs/heads/fleet/next\n', 'abc refs/heads/fleet/next\n', '', ' M file\n']
  t.mock.method(childProcess, 'execFileSync', (...args: unknown[]) => {
    calls.push(args)
    return results.shift()
  })
  syncBuiltinESMExports()
  try {
    assert.equal(getCurrentBranch(hostilePath), 'fleet/next')
    assert.equal(hasUncommittedChanges(hostilePath), false)
    assert.equal(hasUncommittedChanges(hostilePath, { uid: 123, gid: 456 }), true)
    assert.deepEqual(calls.map(call => call.slice(0, 2)), [
      ['git', ['symbolic-ref', '--quiet', 'HEAD']],
      ['git', ['show-ref', '--verify', '--quiet', 'refs/heads/fleet/next']],
      ['git', ['status', '--porcelain']],
      ['git', ['status', '--porcelain']],
    ])
    for (const call of calls) {
      const opts = call[2] as childProcess.ExecFileSyncOptions
      assert.equal(opts.cwd, hostilePath)
      assert.equal(opts.timeout, 2000)
      assert.equal(opts.killSignal, 'SIGKILL')
      assert.equal(opts.shell, undefined)
      assert.equal(opts.encoding, 'utf8')
      assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe'])
      assert.equal(opts.env?.GIT_TERMINAL_PROMPT, '0')
      assert.equal(opts.env?.GIT_ASKPASS, '/bin/false')
      assert.equal(opts.env?.SSH_ASKPASS, '/bin/false')
      assert.equal(opts.env?.GIT_SSH_COMMAND, 'ssh -oBatchMode=yes')
    }
    assert.equal((calls[0][2] as childProcess.ExecFileSyncOptions).uid, undefined)
    assert.equal((calls[3][2] as childProcess.ExecFileSyncOptions).uid, 123)
    assert.equal((calls[3][2] as childProcess.ExecFileSyncOptions).gid, 456)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

for (const failure of [{ code: 'ETIMEDOUT', signal: 'SIGKILL' }, { status: 128 }]) {
  test(`read failures are sanitized: ${JSON.stringify(failure)}`, t => {
    t.mock.method(childProcess, 'execFileSync', () => {
      throw Object.assign(new Error('https://user:SECRET@example.com/private'), failure, {
        stderr: 'SECRET stderr', stdout: 'SECRET stdout',
      })
    })
    syncBuiltinESMExports()
    try {
      for (const [operation, probe] of [
        ['branch', getCurrentBranch], ['status', hasUncommittedChanges],
      ] as const) {
        assert.throws(() => probe('/tmp/SECRET; $(echo hostile)'), (error: Error) => {
          assert.equal(error.message, `Git ${operation} unavailable; read probe failed or exceeded 2000ms`)
          assert.equal(error.cause, undefined)
          assert.deepEqual(Object.keys(error), [])
          return true
        })
      }
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  })
}
