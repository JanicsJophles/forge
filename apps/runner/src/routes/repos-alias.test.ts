import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverRepos } from './repos.js'

function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-repos-alias-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const checkout = (name: string) => {
    const path = join(root, name)
    mkdirSync(join(path, '.git'), { recursive: true })
    return path
  }
  return { root, checkout }
}

const cleanGit = {
  getCurrentBranch: () => 'main',
  hasUncommittedChanges: () => false,
}

test('direct aliases and overlapping containers yield one canonical entry and Git read', t => {
  const { root, checkout } = fixture(t)
  const repo = checkout('container/repo')
  const alias = join(root, 'alias')
  const containerAlias = join(root, 'container-alias')
  symlinkSync(repo, alias)
  symlinkSync(join(root, 'container'), containerAlias)
  for (const roots of [[alias], [alias, containerAlias, repo, join(root, 'container')],
    [join(root, 'container'), repo, containerAlias, alias]]) {
    const reads: string[] = []
    assert.deepEqual(discoverRepos(roots, {
      getCurrentBranch: path => { reads.push(path); return 'main' },
      hasUncommittedChanges: path => { reads.push(path); return false },
    }), [{ name: 'repo', path: repo, currentBranch: 'main', dirty: false }])
    assert.deepEqual(reads, [repo, repo])
  }
})

test('broken and unresolvable aliases do not hide valid checkouts', t => {
  const { root, checkout } = fixture(t)
  const repo = checkout('valid')
  const broken = join(root, 'broken')
  const loop = join(root, 'loop')
  symlinkSync(join(root, 'missing'), broken)
  symlinkSync(loop, loop)
  assert.deepEqual(discoverRepos([broken, loop, root], cleanGit).map(r => r.path), [repo])
})

test('alias targets are resolved afresh between discovery calls', t => {
  const { root, checkout } = fixture(t)
  const first = checkout('first')
  const second = checkout('second')
  const alias = join(root, 'alias')
  symlinkSync(first, alias)
  assert.deepEqual(discoverRepos([alias], cleanGit).map(r => r.path), [first])
  unlinkSync(alias)
  symlinkSync(second, alias)
  assert.deepEqual(discoverRepos([alias, second], cleanGit).map(r => r.path), [second])
  unlinkSync(alias)
  symlinkSync(join(root, 'missing'), alias)
  assert.deepEqual(discoverRepos([alias, first], cleanGit).map(r => r.path), [first])
})

test('aliases deduplicate each linked worktree without collapsing shared Git metadata', t => {
  const { root } = fixture(t)
  const repo = join(root, 'repo')
  const worktree = join(root, 'worktree')
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '--allow-empty', '-m', 'initial'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'work', worktree], { stdio: 'pipe' })
  const alias = join(root, 'alias')
  symlinkSync(worktree, alias)
  assert.deepEqual(discoverRepos([alias, root, repo]).map(r => [r.path, r.currentBranch, r.dirty]), [
    [repo, 'main', false], [worktree, 'work', false],
  ])
})
