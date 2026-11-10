import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { gitCommit, gitPull } from './git.js'

function inject(t: Parameters<Parameters<typeof test>[1]>[0], run: (...args: any[]) => any): void {
  t.mock.method(childProcess, 'execFileSync', run)
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
}

test('git writes use finite deadlines, SIGKILL, and literal argv; return trimmed SHA', t => {
  const calls: any[][] = []
  inject(t, (...args) => {
    calls.push(args)
    if (args[1][0] === 'diff') throw { status: 1 }
    return args[1][0] === 'rev-parse' ? ' abc123\n' : ''
  })
  const path = '/tmp/SECRET $(touch owned); spaced'
  const message = 'SECRET `echo hook`'
  assert.equal(gitCommit(path, message, { uid: 123, gid: 456 }), 'abc123')
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [
    ['git', ['add', '-u']], ['git', ['diff', '--cached', '--quiet', '--exit-code']], ['git', ['commit', '-m', message]], ['git', ['rev-parse', 'HEAD']],
  ])
  for (const [, args, options] of calls) {
    assert.equal(options.timeout, args[0] === 'diff' ? 2000 : 30_000)
    assert.equal(options.killSignal, 'SIGKILL')
    assert.equal(options.shell, undefined)
    assert.equal(options.cwd, path)
    assert.equal(options.uid, 123)
    assert.equal(options.gid, 456)
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0')
  }
})

for (const operation of ['staging', 'commit', 'commit SHA lookup']) {
  for (const timeout of [true, false]) {
    test(`${operation} ${timeout ? 'timeout' : 'failure'} is sanitized and stops subsequent writes`, t => {
      let calls = 0
      const failAt = ['staging', 'commit', 'commit SHA lookup'].indexOf(operation) + 1
      inject(t, (_file, args) => {
        if (args[0] === 'diff') throw { status: 1 }
        if (++calls === failAt) throw Object.assign(new Error('https://user:SECRET@example.com'), {
          code: timeout ? 'ETIMEDOUT' : undefined, status: timeout ? null : 128,
          stdout: 'nothing to commit SECRET', stderr: 'SECRET arguments',
        })
        return 'ok'
      })
      assert.throws(() => gitCommit('/tmp/SECRET', 'SECRET'), (error: Error) => {
        assert.equal(error.message, `Git ${operation} ${timeout
          ? 'timed out after 30000ms; check Git hooks and repository filesystem responsiveness'
          : 'failed; check repository permissions, Git hooks, and local changes'}`)
        assert.equal(error.cause, undefined)
        assert.deepEqual(Object.keys(error), [])
        return true
      })
      assert.equal(calls, failAt)
    })
  }
}

test('recursive ownership timeout is bounded and best effort before pull probes', t => {
  const calls: any[][] = []
  inject(t, (...args) => {
    calls.push(args)
    if (args[0] === 'chown') throw { code: 'ETIMEDOUT' }
    return args[1][0] === 'symbolic-ref' ? 'branch' : ''
  })
  const path = '/tmp/repo; $(echo SECRET)'
  gitPull(path, { uid: 123, gid: 456 })
  assert.deepEqual(calls[0].slice(0, 2), ['chown', ['-R', '123:456', path]])
  assert.equal(calls[0][2].timeout, 30_000)
  assert.equal(calls[0][2].killSignal, 'SIGKILL')
  assert.equal(calls[0][2].shell, undefined)
  assert.equal(calls.length, 3)
})
