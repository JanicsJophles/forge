import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { discoverRepos } from './repos.js'

const cleanGit = {
  getCurrentBranch: () => 'main',
  hasUncommittedChanges: () => false,
}

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'forge-repos-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const checkout = (name: string, file = false) => {
    const path = join(root, name)
    mkdirSync(path, { recursive: true })
    if (file) writeFileSync(join(path, '.git'), 'gitdir: /unused/fake')
    else mkdirSync(join(path, '.git'))
    return path
  }
  return { root, checkout }
}

test('includes an allowed checkout root and preserves response fields', t => {
  const { checkout } = fixture(t)
  const path = checkout('repo')
  assert.deepEqual(discoverRepos([path], cleanGit), [
    { name: 'repo', path, currentBranch: 'main', dirty: false },
  ])
})

test('discovers immediate children including .git files, deduplicates and sorts', t => {
  const { root, checkout } = fixture(t)
  const z = checkout('zeta')
  const a = checkout('alpha', true)
  checkout('container/nested')
  mkdirSync(join(root, 'ordinary'))
  const expected = [a, z]
  for (const roots of [[root, a, join(root, '.'), z], [z, a, root]]) {
    assert.deepEqual(discoverRepos(roots, cleanGit).map(repo => repo.path), expected)
  }
})

test('sorts equal names by path independently of allowlist order', t => {
  const { checkout } = fixture(t)
  const a = checkout('a/repo')
  const z = checkout('z/repo')
  assert.deepEqual(discoverRepos([z, a], cleanGit).map(repo => repo.path), [a, z])
})

test('status failure is conservative and does not hide healthy repositories', t => {
  const { root, checkout } = fixture(t)
  const bad = checkout('bad')
  const good = checkout('good')
  const repos = discoverRepos([join(root, 'missing'), root], {
    getCurrentBranch: path => {
      if (path === bad) throw new Error('branch unavailable')
      return 'main'
    },
    hasUncommittedChanges: path => {
      if (path === bad) throw new Error('sensitive stderr must not be exposed')
      return false
    },
  })
  assert.deepEqual(repos, [
    { name: 'bad', path: bad, currentBranch: 'unknown', dirty: true, statusError: 'unavailable' },
    { name: 'good', path: good, currentBranch: 'main', dirty: false },
  ])
})

test('real git reads recognize clean and dirty worktrees', t => {
  const { root } = fixture(t)
  const repo = join(root, 'repo')
  const worktree = join(root, 'worktree')
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '--allow-empty', '-m', 'initial'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'work', worktree], { stdio: 'pipe' })
  assert.deepEqual(discoverRepos([root]).map(r => [r.currentBranch, r.dirty]), [
    ['main', false], ['work', false],
  ])
  writeFileSync(join(worktree, 'untracked'), 'dirty')
  assert.equal(discoverRepos([worktree])[0].dirty, true)
})
