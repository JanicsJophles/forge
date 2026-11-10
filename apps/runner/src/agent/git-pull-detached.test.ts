import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getCurrentBranch, gitPull } from './git.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } }).trim()
}

for (const detached of [false, true]) {
  test(`gitPull skips checkout without a branch upstream (detached=${detached})`, () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-detached-'))
    try {
      git(root, 'init', '--initial-branch=main')
      git(root, 'commit', '--allow-empty', '-m', 'initial')
      // A configured but unavailable upstream proves detached HEAD never pulls.
      if (detached) {
        git(root, 'remote', 'add', 'origin', join(root, 'missing.git'))
        git(root, 'config', 'branch.main.remote', 'origin')
        git(root, 'config', 'branch.main.merge', 'refs/heads/main')
        git(root, 'checkout', '--detach')
      }
      const before = git(root, 'rev-parse', 'HEAD')
      assert.equal(getCurrentBranch(root), detached ? 'HEAD' : 'main')
      assert.doesNotThrow(() => gitPull(root))
      assert.equal(git(root, 'rev-parse', 'HEAD'), before)
      assert.equal(git(root, 'status', '--porcelain'), '')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

for (const invalid of ['not a repository', 'missing checkout', 'missing commit', 'non-commit HEAD']) {
  test(`gitPull rejects invalid checkout: ${invalid}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-invalid-head-'))
    try {
      const checkout = join(root, 'checkout')
      if (invalid !== 'missing checkout') mkdirSync(checkout)
      if (invalid === 'missing commit' || invalid === 'non-commit HEAD') {
        git(checkout, 'init', '--initial-branch=main')
        const head = invalid === 'missing commit' ? '1'.repeat(40)
          : git(checkout, 'hash-object', '-w', '--stdin')
        writeFileSync(join(checkout, '.git', 'HEAD'), `${head}\n`)
      }
      assert.throws(() => gitPull(checkout), (error: Error) => {
        assert.match(error.message, /Git (branch detection|HEAD verification) failed/)
        assert.doesNotMatch(error.message, /checkout|fatal:/)
        assert.equal(error.cause, undefined)
        return true
      })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
