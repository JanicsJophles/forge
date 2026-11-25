import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'forge-workspace-')))
const root = join(base, 'repos')
const upstream = join(base, 'upstream.git')
const outside = join(base, 'outside')
mkdirSync(root)
mkdirSync(outside)
process.env.ALLOWED_REPO_PATHS = root
process.env.WORKSPACE_ROOT = root
process.env.DATA_DIR = join(base, 'data')
const ws = await import('../src/agent/workspace.js')
const me = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 }

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()

// An upstream with main, and the hand-made clone /opt/repos/app that today's tasks use.
git(base, 'init', '-q', '--bare', '-b', 'main', upstream)
git(base, 'clone', '-q', upstream, join(base, 'seed'))
writeFileSync(join(base, 'seed', 'a.txt'), 'one\n')
git(join(base, 'seed'), 'add', 'a.txt')
git(join(base, 'seed'), 'commit', '-qm', 'init')
git(join(base, 'seed'), 'push', '-q', 'origin', 'main')
git(root, 'clone', '-q', upstream, join(root, 'app'))
symlinkSync(outside, join(root, 'escape'))
const mainSha = git(upstream, 'rev-parse', 'main')

const layout = ws.workspaceLayoutFromEnv([root], { WORKSPACE_ROOT: root, WORKSPACE_REPOS: `listed=${upstream}` })
const commitIn = (path: string, file: string) => {
  writeFileSync(join(path, file), 'x\n')
  git(path, 'add', file)
  git(path, 'commit', '-qm', `add ${file}`)
}

test('repo names: existing clones or allowlisted names only, never a path', () => {
  assert.deepEqual(ws.validateWorkspace({ repo: 'app', base: 'main' }, layout), { spec: { repo: 'app', base: 'main' } })
  assert.ok('spec' in ws.validateWorkspace({ repo: 'listed', base: 'release/1.2' }, layout))
  for (const repo of ['../etc', '..', '.mirrors', '.tasks', 'a/b', '/opt/repos/app', 'missing', 'escape', '-x',
    'app$(id)', 'app;id', 'app.lock', '', 7, undefined]) {
    assert.ok('error' in ws.validateWorkspace({ repo, base: 'main' }, layout), String(repo))
  }
  for (const b of ['', '-f', 'a..b', 'a//b', 'a/', 'x.lock', 'a b', 'HEAD@{1}', '.hidden', 'a/.b', 'main;id', 5]) {
    assert.ok('error' in ws.validateWorkspace({ repo: 'app', base: b }, layout), String(b))
  }
  assert.ok('error' in ws.validateWorkspace(null, layout))
  assert.ok('error' in ws.validateWorkspace('app', layout))
})

test('a workspace is a worktree on a new topic branch off origin/<base>, backed by one bare mirror', async () => {
  const path = await ws.createWorkspace(layout, 'task-one', { repo: 'app', base: 'main' }, 'forge/task-one', me)
  assert.equal(path, join(root, '.tasks', 'task-one'))
  assert.equal(git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'forge/task-one')
  assert.equal(git(path, 'rev-parse', 'HEAD'), mainSha)
  assert.equal(git(path, 'remote', 'get-url', 'origin'), upstream)
  const mirror = join(root, '.mirrors', 'app')
  assert.equal(git(mirror, 'rev-parse', '--is-bare-repository'), 'true')
  // Only the topic branch is local, so no topic name can collide with a copied head.
  assert.equal(git(mirror, 'for-each-ref', '--format=%(refname)', 'refs/heads'), 'refs/heads/forge/task-one')
  await assert.rejects(ws.createWorkspace(layout, 'task-dup', { repo: 'app', base: 'main' }, 'forge/task-one', me))
  await assert.rejects(ws.createWorkspace(layout, 'task-bad', { repo: 'app', base: 'main' }, '-b', me), /topic/)
  await assert.rejects(ws.createWorkspace(layout, 'task-nobase', { repo: 'app', base: 'nope' }, 'forge/nobase', me))
  assert.equal(existsSync(join(root, '.tasks', 'task-nobase')), false)
})

test('two tasks on the same repo at once get separate worktrees from the same mirror', async () => {
  const [a, b] = await Promise.all([
    ws.createWorkspace(layout, 'par-a', { repo: 'listed', base: 'main' }, 'forge/par-a', me),
    ws.createWorkspace(layout, 'par-b', { repo: 'listed', base: 'main' }, 'forge/par-b', me),
  ])
  assert.notEqual(a, b)
  writeFileSync(join(a, 'only-a.txt'), 'a\n')
  assert.equal(existsSync(join(b, 'only-a.txt')), false)
  const worktrees = git(join(root, '.mirrors', 'listed'), 'worktree', 'list', '--porcelain')
  assert.match(worktrees, /par-a/)
  assert.match(worktrees, /par-b/)
})

test('cleanup removes only worktrees with nothing to lose', async () => {
  const spec = { repo: 'app', base: 'main' }
  const mirror = join(root, '.mirrors', 'app')
  const mk = (id: string) => ws.createWorkspace(layout, id, spec, `forge/${id}`, me)

  const untouched = await mk('c-none')
  writeFileSync(join(untouched, '.git-ignored-but-not'), '')
  assert.deepEqual(await ws.finishWorkspace(layout, 'c-none', spec, me), { removed: false, reason: 'uncommitted changes' })
  execFileSync('rm', [join(untouched, '.git-ignored-but-not')])
  assert.deepEqual(await ws.finishWorkspace(layout, 'c-none', spec, me), { removed: true, reason: 'clean and pushed' })
  assert.equal(existsSync(untouched), false)
  assert.equal(git(mirror, 'branch', '--list', 'forge/c-none'), '')

  const dirty = await mk('c-dirty')
  writeFileSync(join(dirty, 'a.txt'), 'changed\n')
  assert.equal((await ws.finishWorkspace(layout, 'c-dirty', spec, me)).removed, false)
  assert.ok(existsSync(dirty))

  const unpushed = await mk('c-unpushed')
  commitIn(unpushed, 'b.txt')
  assert.deepEqual(await ws.finishWorkspace(layout, 'c-unpushed', spec, me), { removed: false, reason: 'commits not pushed' })
  assert.ok(existsSync(unpushed))

  const pushed = await mk('c-pushed')
  commitIn(pushed, 'c.txt')
  git(pushed, 'push', '-q', 'origin', 'HEAD:refs/heads/forge/c-pushed')
  git(pushed, 'fetch', '-q', 'origin')
  assert.equal((await ws.finishWorkspace(layout, 'c-pushed', spec, me)).removed, true)
  assert.equal(existsSync(pushed), false)

  assert.deepEqual(await ws.finishWorkspace(layout, 'never-created', spec, me), { removed: false, reason: 'no workspace' })
})

test('a symlink planted where the mirror goes is refused', async () => {
  mkdirSync(join(root, 'other'))
  git(join(root, 'other'), 'init', '-q')
  git(join(root, 'other'), 'remote', 'add', 'origin', upstream)
  symlinkSync(outside, join(root, '.mirrors', 'other'))
  await assert.rejects(ws.createWorkspace(layout, 'sym', { repo: 'other', base: 'main' }, 'forge/sym', me), /not a plain directory/)
})

test('a failed fetch never puts a credential from the remote URL into the error', async () => {
  const credLayout = { ...layout, remotes: { cred: 'http://agent:s3cret-value@127.0.0.1:9/x.git' } }
  await assert.rejects(ws.createWorkspace(credLayout, 'cred', { repo: 'cred', base: 'main' }, 'forge/cred', me),
    (err: Error) => /fetch failed/.test(err.message) && !err.message.includes('s3cret-value'))
})

test('POST /tasks validates workspace requests and keeps repo-path requests unchanged', async () => {
  const { tasksRouter } = await import('../src/routes/tasks.js')
  const app = express()
  app.use(express.json())
  app.use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tasks`
  const post = async (body: unknown) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, error: ((await res.json()) as { error?: string }).error }
  }
  try {
    assert.deepEqual(await post({ prompt: 'p', workspace: { repo: '../etc', base: 'main' } }),
      { status: 400, error: 'workspace.repo must be a plain repository name' })
    assert.deepEqual(await post({ prompt: 'p', workspace: { repo: 'missing', base: 'main' } }),
      { status: 400, error: 'workspace.repo is not an allowed repository' })
    assert.deepEqual(await post({ prompt: 'p', workspace: { repo: 'app', base: '-x' } }),
      { status: 400, error: 'workspace.base must be a branch name' })
    assert.deepEqual(await post({ prompt: 'p', workspace: { repo: 'app', base: 'main' }, branch: 'a..b' }),
      { status: 400, error: 'branch must be a valid branch name' })
    assert.deepEqual(await post({ prompt: 'p', repo: join(root, 'app'), workspace: { repo: 'app', base: 'main' } }),
      { status: 400, error: 'give repo or workspace, not both' })
    assert.deepEqual(await post({ prompt: 'p' }), { status: 400, error: 'repo or workspace is required' })
    assert.deepEqual(await post({ prompt: 'p', repo: join(root, '..') }),
      { status: 400, error: 'repo path is not in ALLOWED_REPO_PATHS' })
  } finally {
    server.close()
  }
})
