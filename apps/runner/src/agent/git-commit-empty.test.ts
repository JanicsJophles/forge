import assert from 'node:assert/strict'
import childProcess, { execFileSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gitCommit } from './git.js'

function fixture(t: { after: (fn: () => void) => void }, unborn = false) {
  const repo = mkdtempSync(join(tmpdir(), 'forge-empty-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', join(repo, '.git', 'hooks'))
  if (!unborn) {
    writeFileSync(join(repo, 'tracked'), 'initial')
    git('add', 'tracked')
    git('commit', '-m', 'initial')
  }
  return { repo, git }
}

for (const unborn of [false, true]) {
  test(`clean index skips commit hooks (unborn=${unborn})`, t => {
    const { repo } = fixture(t, unborn)
    writeFileSync(join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(repo, 'untracked'), 'left alone')
    assert.equal(gitCommit(repo, 'empty'), '')
  })

  test(`staged new file is committed (unborn=${unborn})`, t => {
    const { repo, git } = fixture(t, unborn)
    writeFileSync(join(repo, 'new'), 'staged')
    git('add', 'new')
    assert.equal(gitCommit(repo, 'new file'), git('rev-parse', 'HEAD'))
    assert.equal(git('show', 'HEAD:new'), 'staged')
  })
}

test('tracked edits are staged and committed', t => {
  const { repo, git } = fixture(t)
  writeFileSync(join(repo, 'tracked'), 'updated')
  assert.equal(gitCommit(repo, 'edit'), git('rev-parse', 'HEAD'))
  assert.equal(git('show', 'HEAD:tracked'), 'updated')
})

for (const stream of ['', ' >&2']) {
  test(`failed hook with misleading output stays a sanitized failure (${stream || 'stdout'})`, t => {
    const { repo, git } = fixture(t)
    const before = git('rev-parse', 'HEAD')
    writeFileSync(join(repo, 'tracked'), 'updated')
    writeFileSync(join(repo, '.git/hooks/pre-commit'),
      `#!/bin/sh\necho 'nothing to commit SECRET'${stream}\nexit 1\n`, { mode: 0o755 })
    assert.throws(() => gitCommit(repo, 'edit'), (error: Error) => {
      assert.equal(error.message, 'Git commit failed; check repository permissions, Git hooks, and local changes')
      assert.equal(error.cause, undefined)
      return true
    })
    assert.equal(git('rev-parse', 'HEAD'), before)
    assert.equal(git('diff', '--cached', '--name-only'), 'tracked')
  })
}

for (const failure of [{ status: 128 }, { status: null, code: 'ETIMEDOUT' },
  { status: 1, signal: 'SIGKILL' }, { status: 1, code: 'ETIMEDOUT' }]) {
  test(`index probe failure stops commit: ${JSON.stringify(failure)}`, t => {
    const { repo } = fixture(t)
    const original = childProcess.execFileSync
    const calls: string[] = []
    t.mock.method(childProcess, 'execFileSync', ((file: string, args: string[], options: any) => {
      calls.push(args[0])
      if (args[0] === 'diff') {
        assert.deepEqual(args, ['diff', '--cached', '--quiet', '--exit-code'])
        assert.equal(options.timeout, 2000)
        assert.equal(options.killSignal, 'SIGKILL')
        assert.equal(options.shell, undefined)
        throw Object.assign(new Error('SECRET'), failure, { stderr: 'nothing to commit SECRET' })
      }
      return original(file, args, options)
    }) as typeof execFileSync)
    syncBuiltinESMExports()
    try {
      assert.throws(() => gitCommit(repo, 'edit'), (error: Error) => {
        assert.equal(error.message, 'Git staged diff unavailable; read probe failed or exceeded 2000ms')
        assert.equal(error.cause, undefined)
        return true
      })
      assert.deepEqual(calls, ['add', 'diff'])
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  })
}
