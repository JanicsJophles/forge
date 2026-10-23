import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'

// config.ts and db/schema.ts read env at import time, so set it up first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-route-'))
const dataDir = path.join(root, 'data'), binDir = path.join(root, 'bin'), repo = path.join(root, 'repo')
fs.mkdirSync(dataDir); fs.mkdirSync(binDir); fs.mkdirSync(repo)
Object.assign(process.env, {
  DATA_DIR: dataDir, ALLOWED_REPO_PATHS: root, CLAUDE_RUN_USER: os.userInfo().username,
  PATH: `${binDir}:${process.env.PATH}`,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
})
// Fake agent: edits a tracked file, adds an untracked one; "fail" exits 3, "slow" sleeps.
fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh
for last; do :; done
printf 'more\\n' >> tracked.txt
printf 'a\\nb\\n' > "made-by-$last.txt"
[ "$last" = slow ] && sleep 1
[ "$last" = fail ] && exit 3
exit 0
`, { mode: 0o755 })

// A pre-feature database: no provider/auto_commit/changes columns.
const legacy = new Database(path.join(dataDir, 'forge.db'))
legacy.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL, prompt TEXT NOT NULL,
  status TEXT DEFAULT 'queued', log TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), started_at TEXT,
  completed_at TEXT, error_message TEXT, commit_sha TEXT)`)
legacy.prepare(`INSERT INTO tasks (id, repo, branch, prompt, status, completed_at) VALUES ('old', ?, 'main', 'p', 'completed', datetime('now'))`).run(repo)
legacy.close()

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
git('init', '-q'); fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n'); git('add', '.'); git('commit', '-qm', 'init')

const { db } = await import('../db/schema.js')
const q = await import('../db/queries.js')
const { runTask } = await import('../agent/runner.js')
const { createEmitter } = await import('../agent/stream.js')
const express = (await import('express')).default
const { tasksRouter } = await import('./tasks.js')

let base = ''
const server = express().use(express.json()).use('/tasks', tasksRouter).listen(0)
before(() => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
after(() => { server.close() })

async function run(prompt: string, autoCommit: boolean): Promise<string> {
  const id = `t-${prompt}-${Date.now()}`
  q.insertTask({ id, repo, branch: 'main', prompt, status: 'queued', log: '', createdAt: new Date().toISOString(), provider: 'claude', autoCommit })
  const emitter = createEmitter(id)
  const done = new Promise(resolve => emitter.once('done', resolve))
  await runTask(q.getTask(id)!, emitter)
  await done
  return id
}

test('migration adds a nullable changes column to an existing database', () => {
  const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string; notnull: number }[]
  const changes = cols.find(c => c.name === 'changes')
  assert.ok(changes)
  assert.equal(changes.notnull, 0)
  assert.equal(q.getTaskChanges('old')?.changes, null)
})

test('GET /tasks/:id/changes: 404 unknown, 404 pre-feature task, 409 active task', async () => {
  assert.equal((await fetch(`${base}/tasks/nope/changes`)).status, 404)
  const old = await fetch(`${base}/tasks/old/changes`)
  assert.equal(old.status, 404)
  assert.match((await old.json()).error, /no changes captured/)
  q.insertTask({ id: 'active', repo: '/elsewhere', branch: 'main', prompt: 'p', status: 'running', log: '', createdAt: new Date().toISOString() })
  assert.equal((await fetch(`${base}/tasks/active/changes`)).status, 409)
  q.updateTaskStatus('active', 'failed')
})

test('successful task with auto-commit: changes survive the commit', async () => {
  const startSha = git('rev-parse', 'HEAD')
  const id = await run('ok', true)
  const task = q.getTask(id)!
  assert.equal(task.status, 'completed')
  assert.ok(task.commitSha && task.commitSha !== startSha, 'auto-commit made a commit')
  const res = await fetch(`${base}/tasks/${id}/changes`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.base_sha, startSha)
  assert.equal(body.truncated, false)
  assert.equal(body.overlapping_task_ids, undefined)
  assert.deepEqual(body.files, [
    { path: 'made-by-ok.txt', status: 'added', added: 2, deleted: 0 }, // untracked: not auto-committed (add -u)
    { path: 'tracked.txt', status: 'modified', added: 1, deleted: 0 }, // committed by auto-commit
  ])
  assert.match(task.log, /captured 2 changed file\(s\)/)
})

test('failed task still captures its changes, cumulative over the shared tree', async () => {
  const startSha = git('rev-parse', 'HEAD')
  const id = await run('fail', false)
  assert.equal(q.getTask(id)!.status, 'failed')
  const body = await (await fetch(`${base}/tasks/${id}/changes`)).json()
  assert.equal(body.base_sha, startSha)
  // made-by-ok.txt is the previous task's leftover: tasks share one working tree.
  assert.deepEqual(body.files.map((f: { path: string }) => f.path), ['made-by-fail.txt', 'made-by-ok.txt', 'tracked.txt'])
  assert.equal(body.overlapping_task_ids, undefined, 'back-to-back tasks are not flagged')
})

test('concurrent same-repo tasks flag each other in their snapshots', async () => {
  const [slow, fast] = await Promise.all([run('slow', false), run('fast', false)])
  const slowBody = await (await fetch(`${base}/tasks/${slow}/changes`)).json()
  const fastBody = await (await fetch(`${base}/tasks/${fast}/changes`)).json()
  assert.deepEqual(slowBody.overlapping_task_ids, [fast])
  assert.deepEqual(fastBody.overlapping_task_ids, [slow])
  // The slow task's snapshot contains the fast task's file: the shared-tree caveat.
  assert.ok(slowBody.files.some((f: { path: string }) => f.path === 'made-by-fast.txt'))
})
