import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gitCommit } from './git.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim()
}

// Build an initialized repo with one commit inside a parent dir whose name the
// caller chooses — used to prove paths with shell metacharacters are safe.
function repoUnder(dirName: string): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'forge-noshell-'))
  const parent = join(root, dirName)
  mkdirSync(parent, { recursive: true })
  const repo = join(parent, 'checkout')
  mkdirSync(repo)
  git(repo, 'init', '--initial-branch=main')
  writeFileSync(join(repo, 'file'), 'initial')
  git(repo, 'add', 'file')
  git(repo, 'commit', '-m', 'initial')
  return { root, repo }
}

test('gitCommit stages a tracked modification and returns the new HEAD sha', () => {
  const { root, repo } = repoUnder('plain')
  try {
    const before = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'file'), 'modified')
    const sha = gitCommit(repo, 'update file')
    const head = git(repo, 'rev-parse', 'HEAD')
    assert.equal(sha, head)
    assert.notEqual(sha, before)
    assert.equal(git(repo, 'log', '-1', '--format=%s'), 'update file')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('gitCommit returns "" when there is nothing to commit', () => {
  const { root, repo } = repoUnder('clean')
  try {
    assert.equal(gitCommit(repo, 'no changes'), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A path containing a space and a quote would break any shell-string command;
// execFileSync passes it as one argv element, so the commit must still succeed.
for (const dirName of ["has space", "has'quote", 'semi;colon $dollar']) {
  test(`gitCommit works under a path containing: ${dirName}`, () => {
    const { root, repo } = repoUnder(dirName)
    try {
      writeFileSync(join(repo, 'file'), 'changed')
      const sha = gitCommit(repo, 'commit under tricky path')
      assert.equal(sha, git(repo, 'rev-parse', 'HEAD'))
      assert.match(sha, /^[0-9a-f]{40}$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

// A commit message carrying shell metacharacters must be stored verbatim,
// proving it is an argv element and not interpolated into a command string.
test('gitCommit stores a message with shell metacharacters verbatim', () => {
  const { root, repo } = repoUnder('message')
  try {
    const message = 'fix: $(whoami) && rm -rf / ; "quoted" `backtick`'
    writeFileSync(join(repo, 'file'), 'changed again')
    gitCommit(repo, message)
    assert.equal(git(repo, 'log', '-1', '--format=%s'), message)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
