import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { captureChanges, headSha } from './changes.js'

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_ENV }).trim()

function tempRepo(files: Record<string, string> = {}): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-changes-'))
  git(repo, 'init', '-q')
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true })
    fs.writeFileSync(path.join(repo, p), body)
  }
  if (Object.keys(files).length) { git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init') }
  return repo
}
const byPath = (c: ReturnType<typeof captureChanges>) => Object.fromEntries(c.files.map(f => [f.path, f]))

test('reports modified, deleted, renamed, untracked and binary files', () => {
  const repo = tempRepo({ 'mod.txt': 'old\n', 'gone.txt': 'x\ny\n', 'keep.txt': 'a\nb\n' })
  const base = headSha(repo)
  fs.writeFileSync(path.join(repo, 'mod.txt'), 'old\nnew\nnewer\n')
  fs.rmSync(path.join(repo, 'gone.txt'))
  git(repo, 'mv', 'keep.txt', 'kept.txt')
  fs.mkdirSync(path.join(repo, 'd/e'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'd/e/new.txt'), '1\n2\n3') // no trailing newline still counts 3
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0]))
  const c = captureChanges(repo, base)
  assert.equal(c.error, undefined)
  assert.equal(c.base_sha, base)
  assert.equal(c.truncated, false)
  assert.ok(!Number.isNaN(Date.parse(c.captured_at)))
  assert.deepEqual(byPath(c), {
    'bin.dat': { path: 'bin.dat', status: 'added', added: null, deleted: null },
    'd/e/new.txt': { path: 'd/e/new.txt', status: 'added', added: 3, deleted: 0 },
    'gone.txt': { path: 'gone.txt', status: 'deleted', added: 0, deleted: 2 },
    'keep.txt': { path: 'keep.txt', status: 'deleted', added: 0, deleted: 2 },
    'kept.txt': { path: 'kept.txt', status: 'added', added: 2, deleted: 0 },
    'mod.txt': { path: 'mod.txt', status: 'modified', added: 2, deleted: 0 },
  })
  assert.deepEqual(c.files.map(f => f.path), [...c.files.map(f => f.path)].sort())
})

test('never writes the real index and leaves no temp index behind', () => {
  const repo = tempRepo({ 'a.txt': 'a\n' })
  fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n')
  const before = git(repo, 'status', '--porcelain=v1')
  const indexBytes = fs.readFileSync(path.join(repo, '.git/index'))
  captureChanges(repo, headSha(repo))
  assert.equal(git(repo, 'status', '--porcelain=v1'), before)
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git/index')), indexBytes)
  assert.deepEqual(fs.readdirSync(path.join(repo, '.git')).filter(f => f.startsWith('forge-changes-')), [])
})

test('does not refresh or lock the real index when stat info is stale', () => {
  const repo = tempRepo({ 'a.txt': 'a\n' })
  const idx = path.join(repo, '.git/index'), bytes = fs.readFileSync(idx)
  const later = new Date(Date.now() + 10_000)
  fs.utimesSync(path.join(repo, 'a.txt'), later, later) // plain `git status` would rewrite the index here
  assert.deepEqual(captureChanges(repo, headSha(repo)).files, [])
  assert.deepEqual(fs.readFileSync(idx), bytes)
  fs.writeFileSync(path.join(repo, '.git/index.lock'), '') // a concurrent agent mid-`git add`
  assert.equal(captureChanges(repo, headSha(repo)).error, undefined)
  assert.ok(fs.existsSync(path.join(repo, '.git/index.lock')), 'foreign lock left alone')
})

test('racily clean edits (same size, same timestamp as the index) are still seen', () => {
  const repo = tempRepo()
  git(repo, 'config', 'core.trustctime', 'false'); git(repo, 'config', 'core.checkStat', 'minimal')
  const file = path.join(repo, 'a.txt'), t0 = new Date(Date.now() - 60_000)
  fs.writeFileSync(file, 'a\n'); fs.utimesSync(file, t0, t0)
  git(repo, 'add', 'a.txt'); git(repo, 'commit', '-qm', 'init')
  fs.utimesSync(path.join(repo, '.git/index'), t0, t0) // index no newer than the file: racy
  fs.writeFileSync(file, 'b\n'); fs.utimesSync(file, t0, t0) // stat still matches the entry
  assert.deepEqual(captureChanges(repo, headSha(repo)).files, [{ path: 'a.txt', status: 'modified', added: 1, deleted: 1 }])
})

test('nested repositories are listed without failing the snapshot', () => {
  const repo = tempRepo({ 'a.txt': 'a\n' })
  const empty = path.join(repo, 'scaffold'), full = path.join(repo, 'vendor/lib')
  fs.mkdirSync(empty); git(empty, 'init', '-q'); fs.writeFileSync(path.join(empty, 'x.txt'), 'x\n') // no commit yet
  fs.mkdirSync(full, { recursive: true }); git(full, 'init', '-q'); fs.writeFileSync(path.join(full, 'y.txt'), 'y\n')
  git(full, 'add', '.'); git(full, 'commit', '-qm', 'y')
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n')
  const c = captureChanges(repo, headSha(repo))
  assert.equal(c.error, undefined)
  assert.deepEqual(c.files, [
    { path: 'b.txt', status: 'added', added: 1, deleted: 0 },
    { path: 'scaffold', status: 'added', added: null, deleted: null },
    { path: 'vendor/lib', status: 'added', added: null, deleted: null },
  ])
})

test('worktree rename records (" R new\\0old") do not desync status parsing', () => {
  // The rename source is its own -z field; a name that looks like a status
  // line must not be read as an untracked path.
  const repo = tempRepo({ '?? old.txt': '1\n2\n3\n' })
  fs.renameSync(path.join(repo, '?? old.txt'), path.join(repo, 'new.txt'))
  git(repo, 'add', '-N', 'new.txt') // intent-to-add makes status report a worktree rename
  const c = captureChanges(repo, headSha(repo))
  assert.equal(c.error, undefined)
  assert.deepEqual(c.files.map(f => [f.path, f.status]), [['?? old.txt', 'deleted'], ['new.txt', 'added']])
})

test('includes commits made after base (agent or auto-commit) and staged files', () => {
  const repo = tempRepo({ 'a.txt': 'a\n' })
  const base = headSha(repo)
  fs.writeFileSync(path.join(repo, 'committed.txt'), 'c\nc\n')
  git(repo, 'add', 'committed.txt'); git(repo, 'commit', '-qm', 'agent commit')
  fs.writeFileSync(path.join(repo, 'staged.txt'), 's\n')
  git(repo, 'add', 'staged.txt')
  const c = byPath(captureChanges(repo, base))
  assert.deepEqual(c['committed.txt'], { path: 'committed.txt', status: 'added', added: 2, deleted: 0 })
  assert.deepEqual(c['staged.txt'], { path: 'staged.txt', status: 'added', added: 1, deleted: 0 })
})

test('clean repo reports no files; ignored files are excluded', () => {
  const repo = tempRepo({ '.gitignore': 'node_modules/\n', 'a.txt': 'a\n' })
  fs.mkdirSync(path.join(repo, 'node_modules'))
  fs.writeFileSync(path.join(repo, 'node_modules/x.js'), 'x\n')
  const c = captureChanges(repo, headSha(repo))
  assert.deepEqual(c.files, [])
  assert.equal(c.truncated, false)
})

test('odd file names survive -z parsing', () => {
  const repo = tempRepo({ 'a.txt': 'a\n' })
  for (const name of ['with space.txt', 'tab\tname.txt', 'new\nline.txt', 'ünï.txt']) fs.writeFileSync(path.join(repo, name), 'x\n')
  const c = captureChanges(repo, headSha(repo))
  assert.deepEqual(c.files.map(f => f.path).sort(), ['new\nline.txt', 'tab\tname.txt', 'with space.txt', 'ünï.txt'].sort())
  assert.ok(c.files.every(f => f.added === 1 && f.status === 'added'))
})

test('caps the file count and flags truncation', () => {
  const repo = tempRepo({ 'a.txt': 'a\n' })
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(repo, `f${String(i).padStart(2, '0')}.txt`), 'x\n')
  const c = captureChanges(repo, headSha(repo), {}, 10)
  assert.equal(c.files.length, 10)
  assert.equal(c.truncated, true)
  const exact = captureChanges(repo, headSha(repo), {}, 30)
  assert.equal(exact.files.length, 30)
  assert.equal(exact.truncated, false)
})

test('unborn branch diffs against the empty tree', () => {
  const repo = tempRepo()
  fs.writeFileSync(path.join(repo, 'first.txt'), 'one\ntwo\n')
  assert.equal(headSha(repo), null)
  const c = captureChanges(repo, null)
  assert.equal(c.error, undefined)
  assert.equal(c.base_sha, null)
  assert.deepEqual(c.files, [{ path: 'first.txt', status: 'added', added: 2, deleted: 0 }])
})

test('null base falls back to HEAD', () => {
  const repo = tempRepo({ 'a.txt': 'a\n' })
  fs.writeFileSync(path.join(repo, 'a.txt'), 'b\n')
  const c = captureChanges(repo, null)
  assert.deepEqual(c.files, [{ path: 'a.txt', status: 'modified', added: 1, deleted: 1 }])
})

test('a non-repo returns an error record instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-norepo-'))
  const c = captureChanges(dir, null)
  assert.match(c.error ?? '', /^capture failed: /)
  assert.deepEqual(c.files, [])
})
