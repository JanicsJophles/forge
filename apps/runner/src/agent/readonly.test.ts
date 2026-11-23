import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareReadOnlyCopy, reportReadOnlyChanges } from './readonly.js'

let root: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_COUNT: '0' },
  }).trim()
}

function initRepo(path: string): void {
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 't@t')
  git(path, 'config', 'user.name', 't')
  git(path, 'config', 'commit.gpgsign', 'false')
}

// Build a real repo with committed history AND pre-existing dirty/untracked/ignored
// working state, plus a staged-but-uncommitted file.
function buildRealRepo(): string {
  const repo = mkdtempSync(join(root, 'real-'))
  initRepo(repo)
  writeFileSync(join(repo, 'keep.txt'), 'kept\n')
  writeFileSync(join(repo, 'mod.txt'), 'original\n')
  writeFileSync(join(repo, 'del.txt'), 'doomed\n')
  writeFileSync(join(repo, '.gitignore'), 'secret.log\n')
  git(repo, 'add', 'keep.txt', 'mod.txt', 'del.txt', '.gitignore')
  git(repo, 'commit', '-qm', 'init')
  // Pre-existing uncommitted working state:
  writeFileSync(join(repo, 'mod.txt'), 'MODIFIED\n') // tracked modification
  rmSync(join(repo, 'del.txt')) // tracked deletion
  writeFileSync(join(repo, 'new.txt'), 'brand new\n') // untracked, non-ignored
  writeFileSync(join(repo, 'secret.log'), 'TOP SECRET\n') // untracked, IGNORED
  writeFileSync(join(repo, 'staged.txt'), 'staged content\n')
  git(repo, 'add', 'staged.txt') // staged, uncommitted
  return repo
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-ro-test-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

test('the disposable copy mirrors the real working state but not ignored files', async () => {
  const real = buildRealRepo()
  const dest = join(mkdtempSync(join(root, 'copyroot-')), 'repo')

  const { baseHead } = await prepareReadOnlyCopy(real, dest)
  assert.equal(baseHead, git(real, 'rev-parse', 'HEAD'), 'copy starts at the real HEAD')

  // Working-tree content matches what the agent should see:
  assert.equal(readFileSync(join(dest, 'keep.txt'), 'utf8'), 'kept\n')
  assert.equal(readFileSync(join(dest, 'mod.txt'), 'utf8'), 'MODIFIED\n', 'tracked modification carried over')
  assert.ok(!existsSync(join(dest, 'del.txt')), 'tracked deletion mirrored')
  assert.equal(readFileSync(join(dest, 'new.txt'), 'utf8'), 'brand new\n', 'untracked file carried over')
  assert.equal(readFileSync(join(dest, 'staged.txt'), 'utf8'), 'staged content\n', 'staged file carried over')
  // Ignored files are intentionally NOT copied.
  assert.ok(!existsSync(join(dest, 'secret.log')), 'ignored file must not be copied into the disposable repo')

  // The copy has no remotes — it can neither fetch nor push.
  assert.equal(git(dest, 'remote'), '', 'all remotes removed from the copy')
})

test('the real repo is byte-for-byte unaffected by preparing and mutating the copy', async () => {
  const real = buildRealRepo()
  const dest = join(mkdtempSync(join(root, 'copyroot2-')), 'repo')

  const statusBefore = git(real, 'status', '--porcelain=v2', '--ignored')
  const headBefore = git(real, 'rev-parse', 'HEAD')
  const remotesBefore = git(real, 'remote')
  const secretBefore = readFileSync(join(real, 'secret.log'), 'utf8')

  const { baseHead } = await prepareReadOnlyCopy(real, dest)

  // Simulate a hostile agent doing everything the reviewer worried about — all
  // inside the copy.
  writeFileSync(join(dest, 'evil.txt'), 'pwned\n')
  writeFileSync(join(dest, 'mod.txt'), 'tampered in copy\n')
  git(dest, 'add', '-A')
  git(dest, 'commit', '-qm', 'agent commit in copy')
  mkdirSync(join(dest, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(dest, '.git', 'hooks', 'post-commit'), '#!/bin/sh\necho hooked\n')
  git(dest, 'remote', 'add', 'origin', 'https://example.com/evil.git') // re-add a remote
  git(dest, 'tag', 'v99') // new ref

  // The real repo must be completely unchanged.
  assert.equal(git(real, 'status', '--porcelain=v2', '--ignored'), statusBefore, 'real repo status identical')
  assert.equal(git(real, 'rev-parse', 'HEAD'), headBefore, 'real repo HEAD unmoved')
  assert.equal(git(real, 'remote'), remotesBefore, 'real repo remotes unchanged')
  assert.equal(readFileSync(join(real, 'secret.log'), 'utf8'), secretBefore, 'ignored file untouched')
  assert.equal(readFileSync(join(real, 'mod.txt'), 'utf8'), 'MODIFIED\n', 'real working file untouched')

  // The report describes the copy's changes (information only).
  const report = reportReadOnlyChanges(dest, baseHead)
  assert.ok(report.includes('evil.txt'), 'report lists the agent-created file')
  assert.ok(report.includes('new commits in copy'), 'report flags the agent commit')

  // Final hostile act: the core.worktree escape the reviewer worried about. With
  // revert removed there is no `git clean` to redirect, but assert anyway that even
  // this leaves the real repo byte-for-byte intact.
  git(dest, 'config', 'core.worktree', '/some/other/dir')
  assert.equal(git(real, 'status', '--porcelain=v2', '--ignored'), statusBefore, 'real repo still identical after core.worktree tamper')
  assert.equal(readFileSync(join(real, 'mod.txt'), 'utf8'), 'MODIFIED\n', 'real working file still untouched')
})

test('preparing a copy of a repo with no commits fails (fail closed)', async () => {
  const empty = mkdtempSync(join(root, 'empty-'))
  initRepo(empty) // unborn HEAD, no commits
  const dest = join(mkdtempSync(join(root, 'emptycopy-')), 'repo')
  await assert.rejects(prepareReadOnlyCopy(empty, dest), 'an un-cloneable repo must reject before any agent runs')
})

test('the disposable copy can be removed cleanly after the run', async () => {
  const real = buildRealRepo()
  const copyRoot = mkdtempSync(join(root, 'cleanup-'))
  const dest = join(copyRoot, 'repo')
  await prepareReadOnlyCopy(real, dest)
  assert.ok(existsSync(dest))
  rmSync(copyRoot, { recursive: true, force: true })
  assert.ok(!existsSync(copyRoot), 'copy is fully removed')
})
