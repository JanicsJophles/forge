import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasUncommittedChanges, revertRepo, gitPull } from './git.js'
import { readOnlyGitEnv } from './provider.js'

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

test('revertRepo discards tracked edits and untracked files', () => {
  const repo = mkdtempSync(join(root, 'revert-'))
  initRepo(repo)
  writeFileSync(join(repo, 'tracked.txt'), 'original\n')
  git(repo, 'add', 'tracked.txt')
  git(repo, 'commit', '-qm', 'init')
  // Mutate a tracked file and drop an untracked file + dir.
  writeFileSync(join(repo, 'tracked.txt'), 'tampered\n')
  writeFileSync(join(repo, 'untracked.txt'), 'new\n')
  execFileSync('mkdir', ['-p', join(repo, 'subdir')])
  writeFileSync(join(repo, 'subdir', 'nested.txt'), 'nested\n')
  assert.equal(hasUncommittedChanges(repo), true)

  revertRepo(repo)

  assert.equal(hasUncommittedChanges(repo), false)
  assert.equal(git(repo, 'show', 'HEAD:tracked.txt'), 'original')
  assert.ok(!existsSync(join(repo, 'untracked.txt')))
  assert.ok(!existsSync(join(repo, 'subdir')))
})

test('gitPull onlyIfClean fast-forwards a clean tree but skips a dirty one', () => {
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
  initRepo(work) // set identity in the clone
  const base = git(work, 'rev-parse', 'HEAD')

  // Publisher advances the remote by one commit.
  writeFileSync(join(publisher, 'f.txt'), 'v2\n')
  git(publisher, 'commit', '-qam', 'c2')
  git(publisher, 'push', '-q', 'origin', 'main')

  // Dirty tree: pull must be skipped, HEAD unchanged, local edit preserved.
  appendFileSync(join(work, 'f.txt'), 'local\n')
  gitPull(work, {}, { onlyIfClean: true })
  assert.equal(git(work, 'rev-parse', 'HEAD'), base, 'dirty tree must not advance')
  assert.equal(hasUncommittedChanges(work), true, 'local edit preserved')

  // Clean tree: pull fast-forwards to the remote tip.
  revertRepo(work)
  gitPull(work, {}, { onlyIfClean: true })
  assert.notEqual(git(work, 'rev-parse', 'HEAD'), base, 'clean tree fast-forwards')
  assert.equal(git(work, 'show', 'HEAD:f.txt'), 'v2')
})

test('readOnlyGitEnv blocks git push to a real remote', () => {
  const remote = mkdtempSync(join(root, 'pushremote-'))
  git(remote, 'init', '--bare', '-q')

  const work = mkdtempSync(join(root, 'pushwork-'))
  initRepo(work)
  writeFileSync(join(work, 'f.txt'), 'v1\n')
  git(work, 'add', 'f.txt')
  git(work, 'commit', '-qm', 'c1')
  git(work, 'branch', '-M', 'main')
  // Use a file:// URL so readOnlyGitEnv's scheme rewrite applies.
  git(work, 'remote', 'add', 'origin', `file://${remote}`)

  const blockedEnv = {
    ...readOnlyGitEnv({ ...process.env }),
    GIT_TERMINAL_PROMPT: '0',
  }
  assert.throws(
    () =>
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'push', 'origin', 'main'], {
        cwd: work,
        encoding: 'utf8',
        env: blockedEnv,
        stdio: 'pipe',
      }),
    'push must fail when readOnlyGitEnv is applied',
  )

  // Control: without the block env, the identical push succeeds.
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'push', 'origin', 'main'], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_COUNT: '0' },
    stdio: 'pipe',
  })
  const remoteHead = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()
  assert.equal(remoteHead, git(work, 'rev-parse', 'HEAD'))
})
