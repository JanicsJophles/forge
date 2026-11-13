import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { getCurrentBranch, getHeadCommit, gitCommit, gitPull, hasUncommittedChanges } from './git.js'

const sentinel = 'forge-test-mutation-token'

for (const fail of [false, true]) {
  test(`all Git and ownership subprocesses omit runner credentials (${fail ? 'failure' : 'success'})`, t => {
    const before = { ...process.env }
    Object.assign(process.env, {
      FORGE_AUTH_TOKEN: sentinel, GIT_DIR: '/conflicting/checkout',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'test-helper', HOME: '/test/home',
    })
    const inherited = { ...process.env }
    const calls: string[] = []
    t.mock.method(childProcess, 'execFileSync', (file: string, args: string[], options: childProcess.ExecSyncOptions) => {
      calls.push(`${file}:${args[0]}`)
      const env = options.env!
      assert.equal(Object.hasOwn(env, 'FORGE_AUTH_TOKEN'), false)
      assert.equal(Object.hasOwn(env, 'GIT_DIR'), false)
      for (const key of ['PATH', 'HOME', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
        assert.equal(env[key], inherited[key], key)
      }
      assert.equal(env.GIT_TERMINAL_PROMPT, '0')
      assert.equal(env.GIT_ASKPASS, '/bin/false')
      assert.equal(env.SSH_ASKPASS, '/bin/false')
      assert.equal(env.GIT_SSH_COMMAND, 'ssh -oBatchMode=yes')
      assert.equal(options.shell, undefined)
      if (fail) throw Object.assign(new Error(sentinel), { status: 128, stderr: sentinel })
      if (args[0] === 'diff') throw { status: 1 }
      if (args[0] === 'symbolic-ref') return args.includes('--short') ? 'branch' : 'refs/heads/branch'
      if (args[0] === 'config') return 'refs/heads/branch'
      if (args[0] === 'log') return 'abc123\0subject'
      return 'abc123'
    })
    syncBuiltinESMExports()
    try {
      const operations = [
        () => getCurrentBranch('/fake/repo'), () => getHeadCommit('/fake/repo'),
        () => hasUncommittedChanges('/fake/repo', { uid: 123, gid: 456 }),
        () => gitPull('/fake/repo', { uid: 123, gid: 456 }),
        () => gitCommit('/fake/repo', 'message', { uid: 123, gid: 456 }),
      ]
      for (const operation of operations) {
        if (fail) assert.throws(operation, (error: Error) => {
          assert.equal(error.message.includes(sentinel), false)
          assert.equal(JSON.stringify(error).includes(sentinel), false)
          assert.equal(error.cause, undefined)
          return true
        })
        else operation()
      }
      assert.deepEqual({ ...process.env }, inherited)
      if (!fail) assert.deepEqual(calls, [
        'git:symbolic-ref', 'git:show-ref', 'git:log', 'git:status',
        'chown:-R', 'git:symbolic-ref', 'git:config', 'git:pull',
        'git:add', 'git:diff', 'git:commit', 'git:rev-parse',
      ])
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]
      Object.assign(process.env, before)
    }
  })
}
