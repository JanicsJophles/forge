import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { getAheadBehind } from '../agent/git-tracking.js'
import { discoverRepos } from './repos.js'

// Run every git command with a fixed identity and no global config leakage, so
// the test is hermetic regardless of the host's git setup.
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

function commit(cwd: string, name: string, message: string): void {
  writeFileSync(join(cwd, name), message)
  git(cwd, 'add', name)
  git(cwd, 'commit', '-m', message)
}

function workspace(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-tracking-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('getAheadBehind reports local ahead/behind against the tracked upstream without fetching', t => {
  const root = workspace(t)
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  const other = join(root, 'other')

  // A bare "remote" plus a clone whose main tracks origin/main.
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' })
  git(root, 'clone', origin, 'work')
  commit(work, 'a', 'first')
  // -u configures the upstream; cloning an empty bare repo leaves main untracked.
  git(work, 'push', '-u', 'origin', 'main')

  // A second clone advances origin by one commit.
  git(root, 'clone', origin, 'other')
  commit(other, 'b', 'remote advance')
  git(other, 'push', 'origin', 'main')

  // work's remote-tracking ref only learns of that commit via an explicit fetch
  // in the test setup — getAheadBehind itself must never fetch.
  git(work, 'fetch', 'origin')
  // One local-only commit makes work simultaneously ahead and behind.
  commit(work, 'c', 'local advance')

  assert.deepEqual(getAheadBehind(work), { ahead: 1, behind: 1 })

  // Advance the remote once more. Because getAheadBehind never fetches, work's
  // remote-tracking ref stays put and the counts are unchanged — a fetching
  // implementation would instead report behind: 2.
  commit(other, 'd', 'second remote advance')
  git(other, 'push', 'origin', 'main')
  assert.deepEqual(getAheadBehind(work), { ahead: 1, behind: 1 })
})

test('getAheadBehind returns null for a branch with no upstream', t => {
  const root = workspace(t)
  const repo = join(root, 'solo')
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' })
  commit(repo, 'a', 'only commit')
  assert.equal(getAheadBehind(repo), null)
})

test('discoverRepos surfaces ahead/behind and isolates a single probe failure', t => {
  const root = workspace(t)
  const tracked = join(root, 'tracked')
  const broken = join(root, 'broken')
  execFileSync('git', ['init', '-b', 'main', tracked], { stdio: 'pipe' })
  execFileSync('git', ['init', '-b', 'main', broken], { stdio: 'pipe' })

  const repos = discoverRepos([root], {
    getCurrentBranch: () => 'main',
    getHeadCommit: () => ({ sha: 'abc1234', subject: 'initial' }),
    hasUncommittedChanges: () => false,
    getAheadBehind: path => {
      if (path === broken) throw new Error('sensitive stderr must not be exposed')
      return { ahead: 2, behind: 3 }
    },
  })

  assert.deepEqual(
    repos.map(r => [r.name, r.ahead, r.behind]),
    [['broken', null, null], ['tracked', 2, 3]],
  )
})
