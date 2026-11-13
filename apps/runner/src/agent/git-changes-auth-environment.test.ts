import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getChangedFiles, getChangesPatch } from './git-changes.js'

for (const mode of ['committed', 'live', 'unborn'] as const) {
  test(`${mode} footprint and patch subprocesses omit mutation credentials`, t => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-changes-auth-'))
    const before = { ...process.env }
    const selectors = [
      'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES',
    ]
    Object.assign(process.env, {
      FORGE_AUTH_TOKEN: 'disposable-change-inspection-sentinel',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'test-helper',
    })
    for (const key of selectors) process.env[key] = '/conflicting/checkout'
    const inherited = { ...process.env }
    const calls: string[] = []
    t.mock.method(childProcess, 'execFileSync', (file: string, args: string[], options: childProcess.ExecSyncOptions) => {
      const command = args[0] === '-c' ? args[2] : args[0]
      calls.push(command)
      assert.equal(file, 'git')
      assert.equal(options.cwd, repo)
      const env = options.env!
      assert.equal(Object.hasOwn(env, 'FORGE_AUTH_TOKEN'), false)
      for (const key of selectors) assert.equal(Object.hasOwn(env, key), false, key)
      for (const key of ['PATH', 'HOME', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
        assert.equal(env[key], inherited[key], key)
      }
      assert.equal(env.GIT_TERMINAL_PROMPT, '0')
      assert.equal(env.GIT_ASKPASS, '/bin/false')
      assert.equal(env.SSH_ASKPASS, '/bin/false')
      assert.equal(env.GIT_SSH_COMMAND, 'ssh -oBatchMode=yes')
      assert.equal(options.shell, undefined)
      assert.equal(options.timeout, 2_000)
      assert.equal(options.killSignal, 'SIGKILL')
      if (command === 'rev-parse' || command === 'show-ref') {
        if (mode === 'unborn') throw { status: 1 }
        return 'a'.repeat(40)
      }
      if (command === 'symbolic-ref') return 'refs/heads/test'
      if (command === 'status') return '?? new.txt\0'
      assert.ok(args.includes('--no-ext-diff'))
      assert.ok(args.includes('--no-textconv'))
      if (options.encoding === 'utf8') return 'M\0tracked.txt\0'
      assert.ok(args.includes('--no-color'))
      assert.equal(options.maxBuffer, 64 * 1024 * 1024)
      return Buffer.from('patch\n')
    })
    syncBuiltinESMExports()
    try {
      const sha = mode === 'committed' ? 'a'.repeat(40) : undefined
      assert.deepEqual(getChangedFiles(repo, sha), [
        { path: 'tracked.txt', status: 'M' },
        ...(mode === 'committed' ? [] : [{ path: 'new.txt', status: '?' }]),
      ])
      assert.deepEqual(getChangesPatch(repo, sha), { patch: 'patch\n', truncated: false })
      assert.deepEqual(calls, mode === 'committed' ? ['show', 'show'] : mode === 'live'
        ? ['rev-parse', 'diff', 'status', 'rev-parse', 'diff']
        : ['rev-parse', 'symbolic-ref', 'show-ref', 'diff', 'status', 'rev-parse', 'symbolic-ref', 'show-ref', 'diff'])
      assert.deepEqual({ ...process.env }, inherited)
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]
      Object.assign(process.env, before)
      rmSync(repo, { recursive: true, force: true })
    }
  })
}
