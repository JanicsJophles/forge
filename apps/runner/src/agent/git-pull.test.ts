import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gitPull } from './git.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } }).trim()
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-pull-'))
  const remote = join(root, 'remote.git')
  const source = join(root, 'source')
  const clone = join(root, 'clone')
  git(root, 'init', '--bare', '--initial-branch=main', remote)
  git(root, 'clone', remote, source)
  writeFileSync(join(source, 'file'), 'initial')
  git(source, 'add', 'file')
  git(source, 'commit', '-m', 'initial')
  git(source, 'push', '-u', 'origin', 'main')
  git(root, 'clone', remote, clone)
  return { root, remote, source, clone }
}

for (const scenario of ['fast-forward', 'no upstream', 'divergent', 'unavailable', 'local changes', 'missing tracking ref'] as const) {
  test(`gitPull: ${scenario}`, () => {
    const f = fixture()
    try {
      const before = git(f.clone, 'rev-parse', 'HEAD')
      if (scenario === 'no upstream') git(f.clone, 'branch', '--unset-upstream')
      if (scenario === 'unavailable') rmSync(f.remote, { recursive: true })
      if (scenario === 'missing tracking ref') {
        git(f.clone, 'update-ref', '-d', 'refs/remotes/origin/main')
        rmSync(f.remote, { recursive: true })
      }
      if (scenario === 'divergent') {
        writeFileSync(join(f.clone, 'local'), 'local')
        git(f.clone, 'add', 'local')
        git(f.clone, 'commit', '-m', 'local')
      }
      if (scenario === 'local changes') writeFileSync(join(f.clone, 'file'), 'dirty')
      if (!['unavailable', 'missing tracking ref'].includes(scenario)) {
        writeFileSync(join(f.source, 'file'), 'remote update')
        git(f.source, 'commit', '-am', 'remote update')
        git(f.source, 'push')
      }
      if (scenario === 'fast-forward') {
        gitPull(f.clone)
        assert.equal(git(f.clone, 'rev-parse', 'HEAD'), git(f.source, 'rev-parse', 'HEAD'))
      } else if (scenario === 'no upstream') {
        gitPull(f.clone)
        assert.equal(git(f.clone, 'rev-parse', 'HEAD'), before)
      } else {
        assert.throws(() => gitPull(f.clone), /Git pull failed; check/)
      }
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
}

test('repository errors propagate', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-not-repo-'))
  try { assert.throws(() => gitPull(root), /Git branch detection failed/) }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('hung pull is bounded, noninteractive, and does not leak output', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-hung-pull-'))
  const oldPath = process.env.PATH
  try {
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'git'), `#!${process.execPath}
if (process.argv[2] === 'symbolic-ref') console.log('main');
else if (process.argv[2] === 'config') console.log('refs/heads/main');
else {
  if (process.env.GIT_TERMINAL_PROMPT !== '0' || process.env.GIT_ASKPASS !== '/bin/false' || !process.env.GIT_SSH_COMMAND.includes('BatchMode=yes')) process.exit(9);
  console.error('https://user:SECRET@example.com/private');
  setInterval(() => {}, 1000);
}
`, { mode: 0o755 })
    process.env.PATH = `${join(root, 'bin')}:${oldPath}`
    const started = Date.now()
    assert.throws(() => gitPull(root, {}, 500), (error: Error) => {
      assert.match(error.message, /Git pull timed out after 500ms/)
      assert.doesNotMatch(error.message, /SECRET|https:/)
      assert.equal(error.cause, undefined)
      return true
    })
    assert.ok(Date.now() - started < 5000)
  } finally {
    process.env.PATH = oldPath
    rmSync(root, { recursive: true, force: true })
  }
})
