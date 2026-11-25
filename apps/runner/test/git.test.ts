import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'forge-git-')))
const root = join(base, 'repos')
const repo = join(root, 'app')
mkdirSync(repo, { recursive: true })
process.env.ALLOWED_REPO_PATHS = root
const { gitCommit, gitPull, getCurrentBranch } = await import('../src/agent/git.js')
const me = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 }

const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo })
g('init', '-q', '-b', 'main')
writeFileSync(join(repo, 'a.txt'), 'one\n')
g('add', 'a.txt')
g('commit', '-qm', 'init')
g('config', 'user.name', 't')
g('config', 'user.email', 't@t')

test('a commit message is an argument, never shell', { skip: me.uid === 0 }, () => {
  const marker = join(base, 'pwned')
  writeFileSync(join(repo, 'a.txt'), 'two\n')
  const sha = gitCommit(repo, `[forge] $(touch ${marker}) \`touch ${marker}\` "; touch ${marker}`, me)
  assert.match(sha, /^[0-9a-f]{40}$/)
  assert.equal(existsSync(marker), false)
  assert.equal(getCurrentBranch(repo, me), 'main')
})

test('git refuses to run as root', () => {
  assert.throws(() => getCurrentBranch(repo, { uid: 0, gid: 0 }), /non-root/)
})

test('the ownership pass refuses a path outside ALLOWED_REPO_PATHS', () => {
  assert.throws(() => gitPull(join(root, '..'), me), /ALLOWED_REPO_PATHS/)
  assert.throws(() => gitPull(`${repo}$(id)`, me), /ALLOWED_REPO_PATHS/)
})
