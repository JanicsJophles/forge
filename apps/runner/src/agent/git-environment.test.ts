import assert from 'node:assert/strict'
import childProcess, { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getCurrentBranch, gitCommit, gitPull, hasUncommittedChanges } from './git.js'

const selectors = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES',
]

function withSelectors(values: Record<string, string>, run: () => void) {
  const before = { ...process.env }
  try {
    Object.assign(process.env, values)
    const inherited = { ...process.env }
    run()
    assert.deepEqual({ ...process.env }, inherited, 'helpers must not mutate process.env')
  } finally {
    for (const key of Object.keys(values)) {
      if (before[key] === undefined) delete process.env[key]
      else process.env[key] = before[key]
    }
  }
}

test('branch and status read the supplied checkout despite conflicting selectors', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-git-env-'))
  const env = { ...process.env }
  for (const key of selectors) delete env[key]
  function git(cwd: string, ...args: string[]) {
    return execFileSync('git', args, { cwd, env, stdio: 'pipe', encoding: 'utf8' }).trim()
  }
  try {
    const target = join(root, 'target')
    const other = join(root, 'other')
    for (const [path, branch] of [[target, 'target'], [other, 'other']]) {
      git(root, 'init', '--initial-branch=' + branch, path)
      git(path, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial')
    }
    writeFileSync(join(other, 'dirty'), 'other checkout')
    const values = {
      GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other,
      GIT_COMMON_DIR: join(other, '.git'), GIT_INDEX_FILE: join(other, '.git/index'),
      GIT_OBJECT_DIRECTORY: join(other, '.git/objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(other, '.git/objects'), GIT_CEILING_DIRECTORIES: root,
    }
    withSelectors(values, () => {
      assert.equal(getCurrentBranch(target), 'target')
      assert.equal(hasUncommittedChanges(target), false)
      writeFileSync(join(target, 'dirty'), 'target checkout')
      rmSync(join(other, 'dirty'))
      assert.equal(hasUncommittedChanges(target), true)
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pull and commit receive isolated noninteractive environments', t => {
  const calls: { file: string; command: string[]; options: childProcess.ExecSyncOptions }[] = []
  // Every subprocess — git AND chown — now runs shell-free via execFileSync, so
  // a single mock captures the full argv for each call.
  t.mock.method(childProcess, 'execFileSync', (file: string, args: string[], options: childProcess.ExecSyncOptions) => {
    calls.push({ file, command: args, options })
    if (file !== 'git') return '' // chown (ownership), not a Git call
    return args[0] === 'symbolic-ref'
      ? 'main\n'
      : args[0] === 'config'
        ? 'refs/heads/main\n'
        : args[0] === 'rev-parse'
          ? 'abc123\n'
          : ''
  })
  syncBuiltinESMExports()
  try {
    withSelectors(Object.fromEntries(selectors.map(key => [key, '/conflicting/checkout'])), () => {
      gitPull('/supplied/checkout', { uid: 123, gid: 456 }, 789)
      assert.equal(gitCommit('/supplied/checkout', 'message', { uid: 123, gid: 456 }), 'abc123')

      // Ownership is fixed without a shell: the repo path is a lone argv
      // element, never interpolated into a command string.
      const chown = calls.filter(call => call.file === 'chown')
      assert.equal(chown.length, 1)
      assert.deepEqual(chown[0].command, ['-R', '123:456', '/supplied/checkout'])

      const git = calls.filter(call => call.file === 'git')
      assert.deepEqual(git.map(call => call.command), [
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        ['config', '--get', 'branch.main.merge'],
        ['pull', '--ff-only'],
        ['add', '-u'],
        ['commit', '-m', 'message'],
        ['rev-parse', 'HEAD'],
      ])
      for (const { options } of git) {
        for (const key of selectors) assert.equal(Object.hasOwn(options.env!, key), false, key)
        assert.equal(options.cwd, '/supplied/checkout')
        assert.equal(options.uid, 123)
        assert.equal(options.gid, 456)
        assert.equal(options.env?.PATH, process.env.PATH)
        assert.equal(options.env?.GIT_TERMINAL_PROMPT, '0')
        assert.equal(options.env?.GIT_ASKPASS, '/bin/false')
        assert.equal(options.env?.SSH_ASKPASS, '/bin/false')
        assert.equal(options.env?.GIT_SSH_COMMAND, 'ssh -oBatchMode=yes')
      }
      // The three read/pull probes stay bounded and hard-killed.
      for (const { options } of git.slice(0, 3)) {
        assert.equal(options.timeout, 789)
        assert.equal(options.killSignal, 'SIGKILL')
      }
    })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})
