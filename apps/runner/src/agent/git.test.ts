import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitCommit, hasUncommittedChanges } from './git.js'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-git-'))
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  run('init', '-q'); run('config', 'user.email', 't@example.com'); run('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.txt'), 'one\n'); run('add', 'a.txt'); run('commit', '-q', '-m', 'init')
  return dir
}

test('a commit message from a task prompt is never run by a shell', () => {
  const dir = repo()
  const marker = join(dir, 'pwned')
  writeFileSync(join(dir, 'a.txt'), 'two\n')
  const message = `[forge] fix $(touch ${marker}) \`touch ${marker}\` "quoted" 'single' ; touch ${marker}`
  const sha = gitCommit(dir, message)
  assert.match(sha, /^[0-9a-f]{40}$/)
  assert.equal(existsSync(marker), false)
  assert.equal(execFileSync('git', ['log', '-1', '--format=%B'], { cwd: dir, encoding: 'utf8' }).trim(), message)
})

test('nothing to commit returns an empty sha; status reports changes', () => {
  const dir = repo()
  assert.equal(hasUncommittedChanges(dir), false)
  assert.equal(gitCommit(dir, 'noop'), '')
  writeFileSync(join(dir, 'a.txt'), 'three\n')
  assert.equal(hasUncommittedChanges(dir), true)
})
