import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getCurrentBranch } from './git.js'

function fixture(t: { after: (fn: () => void) => void }) {
  const repo = mkdtempSync(join(tmpdir(), 'forge-branch-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q', '-b', 'feature/new-checkout')
  return { repo, git }
}

test('branch discovery preserves unborn, committed, and detached checkout semantics', t => {
  const { repo, git } = fixture(t)
  assert.equal(getCurrentBranch(repo), 'feature/new-checkout')
  git('commit', '--allow-empty', '-qm', 'initial')
  assert.equal(getCurrentBranch(repo), 'feature/new-checkout')
  git('checkout', '--detach', '-q')
  assert.equal(getCurrentBranch(repo), 'HEAD')
})

for (const invalid of ['non-repository', 'missing directory', 'broken HEAD', 'broken ref', 'missing object', 'broken detached']) {
  test(`branch discovery sanitizes ${invalid}`, t => {
    const { repo } = fixture(t)
    let target = repo
    if (invalid === 'non-repository') rmSync(join(repo, '.git'), { recursive: true })
    if (invalid === 'missing directory') target = join(repo, 'SECRET-missing')
    if (invalid === 'broken HEAD') writeFileSync(join(repo, '.git/HEAD'), 'SECRET broken HEAD\n')
    if (invalid === 'broken ref' || invalid === 'missing object') {
      mkdirSync(join(repo, '.git/refs/heads/feature'), { recursive: true })
      writeFileSync(join(repo, '.git/refs/heads/feature/new-checkout'),
        invalid === 'broken ref' ? 'SECRET invalid ref\n' : `${'f'.repeat(40)}\n`)
    }
    if (invalid === 'broken detached') writeFileSync(join(repo, '.git/HEAD'), `${'f'.repeat(40)}\n`)
    assert.throws(() => getCurrentBranch(target), (error: Error) => {
      assert.equal(error.message, 'Git branch unavailable; read probe failed or exceeded 2000ms')
      assert.equal(error.cause, undefined)
      assert.deepEqual(Object.keys(error), [])
      return true
    })
  })
}
