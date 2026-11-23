import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasUncommittedChanges, gitPull, getCurrentBranch } from './git.js'

let root: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_COUNT: '0' },
  }).trim()
}

function initRepo(path: string): void {
  git(path, 'init', '-q')
  git(path, 'config', 'user.email', 't@t')
  git(path, 'config', 'user.name', 't')
  git(path, 'config', 'commit.gpgsign', 'false')
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-git-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('hasUncommittedChanges reflects working-tree state', () => {
  const repo = mkdtempSync(join(root, 'clean-'))
  initRepo(repo)
  writeFileSync(join(repo, 'a.txt'), 'hi\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'init')
  assert.equal(hasUncommittedChanges(repo), false)
  appendFileSync(join(repo, 'a.txt'), 'more\n')
  assert.equal(hasUncommittedChanges(repo), true)
})

test('getCurrentBranch returns the checked-out branch', () => {
  const repo = mkdtempSync(join(root, 'branch-'))
  initRepo(repo)
  writeFileSync(join(repo, 'a.txt'), 'hi\n')
  git(repo, 'add', 'a.txt')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'branch', '-M', 'main')
  assert.equal(getCurrentBranch(repo), 'main')
})

test('gitPull fast-forwards a clean tree from its upstream', () => {
  const remote = mkdtempSync(join(root, 'remote-'))
  git(remote, 'init', '--bare', '-q', '-b', 'main')

  const publisher = mkdtempSync(join(root, 'pub-'))
  initRepo(publisher)
  writeFileSync(join(publisher, 'f.txt'), 'v1\n')
  git(publisher, 'add', 'f.txt')
  git(publisher, 'commit', '-qm', 'c1')
  git(publisher, 'branch', '-M', 'main')
  git(publisher, 'remote', 'add', 'origin', remote)
  git(publisher, 'push', '-q', '-u', 'origin', 'main')

  const work = mkdtempSync(join(root, 'work-'))
  git(root, 'clone', '-q', remote, work)
  initRepo(work)
  const base = git(work, 'rev-parse', 'HEAD')

  writeFileSync(join(publisher, 'f.txt'), 'v2\n')
  git(publisher, 'commit', '-qam', 'c2')
  git(publisher, 'push', '-q', 'origin', 'main')

  gitPull(work)
  assert.notEqual(git(work, 'rev-parse', 'HEAD'), base, 'clean tree fast-forwards')
  assert.equal(git(work, 'show', 'HEAD:f.txt'), 'v2')
})

test('gitPull is a no-op when no upstream is configured', () => {
  const repo = mkdtempSync(join(root, 'noupstream-'))
  initRepo(repo)
  writeFileSync(join(repo, 'f.txt'), 'v1\n')
  git(repo, 'add', 'f.txt')
  git(repo, 'commit', '-qm', 'c1')
  const before = git(repo, 'rev-parse', 'HEAD')
  gitPull(repo) // must not throw
  assert.equal(git(repo, 'rev-parse', 'HEAD'), before)
})
