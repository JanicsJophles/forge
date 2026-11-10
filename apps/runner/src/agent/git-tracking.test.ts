import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { getAheadBehind } from './git-tracking.js'

test('tracking probe bounds execution and discards failures and malformed counts', t => {
  let result: string | Error = '3\t2\n'
  t.mock.method(childProcess, 'execFileSync', (...args: unknown[]) => {
    assert.equal(args[0], 'git')
    assert.deepEqual(args[1], ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
    const opts = args[2] as childProcess.ExecFileSyncOptions
    assert.equal(opts.cwd, '/tmp/repo; $(echo private)')
    assert.equal(opts.timeout, 2000)
    assert.equal(opts.killSignal, 'SIGKILL')
    assert.equal(opts.shell, undefined)
    assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(opts.env?.GIT_TERMINAL_PROMPT, '0')
    if (result instanceof Error) throw result
    return result
  })
  syncBuiltinESMExports()
  try {
    const probe = () => getAheadBehind('/tmp/repo; $(echo private)')
    assert.deepEqual(probe(), { ahead: 2, behind: 3 })
    for (const invalid of ['', '1', '1 2 3', '-1 2', '1.5 2', 'NaN 2', '9007199254740992 0']) {
      result = invalid
      assert.equal(probe(), null)
    }
    for (const failure of [{ code: 'ETIMEDOUT' }, { status: 128 }]) {
      result = Object.assign(new Error('private credentials'), failure, { stderr: 'private stderr' })
      assert.equal(probe(), null)
    }
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})
