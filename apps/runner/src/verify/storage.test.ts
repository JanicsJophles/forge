import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { fixture } from './fixtures.js'
import Database from 'better-sqlite3'

test('existing database migrates additively and persists options, reports and terminal timestamps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-storage-'))
  process.env.DATA_DIR = root
  const old = new Database(join(root, 'forge.db'))
  old.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, repo TEXT, branch TEXT, prompt TEXT, status TEXT, log TEXT,
    created_at TEXT, started_at TEXT, completed_at TEXT, error_message TEXT, commit_sha TEXT
  )`)
  old.close()
  const { db } = await import('../db/schema.js')
  try {
    assert.deepEqual(db.prepare('SELECT id FROM _migrations').all(), [{ id: '001_verification' }])
    const q = await import('../db/queries.js')
    const options = { repo: root, prompt: 'PR', gate: 'true', maxOutputBytes: 1024 }
    q.insertTask({ id: 'test', repo: root, branch: 'feature', prompt: 'PR', log: '', status: 'queued', createdAt: new Date().toISOString(), options })
    assert.deepEqual(q.getTask('test')?.options, options)
    const report = { verdict: 'unverified' as const, verified: false, checks: [{ name: 'gate', ok: false, detail: 'gate exited 1' }], diffStats: '', gate: { cmd: 'private-command', exit: 1, tail: 'private-gate-output' } }
    q.setVerification('test', report)
    assert.deepEqual(q.getTask('test')?.verification, report)
    for (const status of ['failed'] as const) {
      q.updateTaskStatus('test', status)
      assert.equal(q.getTask('test')?.status, status)
      assert.ok(q.getTask('test')?.completedAt)
      assert.equal(q.countActiveTasks(), 0)
    }
    for (const kind of ['unverified', 'capped'] as const) {
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(kind, 'test')
      assert.equal(q.getTask('test')?.status, 'failed')
      // Legacy capped rows carry no verdict in their saved report.
      q.setVerification('test', { ...report, verdict: kind })
      assert.equal(q.getTask('test')?.failureKind, kind)
      assert.equal(q.getTask('test')?.verification?.verdict, kind)
      assert.ok(q.getTask('test')?.completedAt)
      assert.equal(q.countActiveTasks(), 0)
    }
    const f = fixture()
    const savedPath = process.env.PATH
    try {
      process.env.PATH = `${join(f.root, 'bin')}:${savedPath}`
      process.env.ALLOWED_REPO_PATHS = f.repo
      process.env.CLAUDE_RUN_USER = 'forge-test-nonexistent'
      process.env.REQUIRE_DRAFT_PR = 'true'
      process.env.AUTO_COMMIT = 'false'
      writeFileSync(join(f.root, 'bin', 'claude'), '#!/bin/sh\necho https://github.com/example/repo/pull/1\n', { mode: 0o755 })
      const { runTask } = await import('../agent/runner.js')
      for (const expected of ['completed', 'unverified', 'capped'] as const) {
        if (expected === 'unverified') f.missingPR()
        const task = { id: expected, repo: f.repo, branch: 'feature', prompt: 'Open a PR', log: '', status: 'queued' as const, createdAt: new Date().toISOString(), options: { repo: f.repo, prompt: 'Open a PR', maxOutputBytes: expected === 'capped' ? 1 : 10000 } }
        q.insertTask(task)
        const emitter = new EventEmitter()
        const done = new Promise<void>(resolve => emitter.once('done', resolve))
        await runTask(task, emitter)
        await done
        assert.equal(q.getTask(task.id)?.status, expected === 'completed' ? 'completed' : 'failed')
        assert.equal(q.getTask(task.id)?.failureKind, expected === 'completed' ? undefined : expected)
        assert.equal(q.getTask(task.id)?.verification?.verdict, expected === 'completed' ? 'verified' : expected)
        if (expected !== 'completed') assert.ok(q.getTask(task.id)?.errorMessage)
        assert.equal(q.getTask(task.id)?.verification?.verified, expected === 'completed')
      }
      const { default: express } = await import('express')
      const { tasksRouter } = await import('../routes/tasks.js')
      const app = express()
      app.use(express.json())
      app.use('/tasks', tasksRouter)
      const server = app.listen(0, '127.0.0.1')
      await new Promise<void>(resolve => server.once('listening', resolve))
      const address = server.address() as { port: number }
      const url = `http://127.0.0.1:${address.port}/tasks`
      try {
        const detail = await (await fetch(`${url}/unverified`)).json() as { status: string; failureKind: string; errorMessage: string; verification: { verified: boolean } }
        assert.equal((detail as any).options, undefined)
        assert.equal((detail as any).verification.gate, null)
        assert.equal(detail.status, 'failed')
        assert.equal(detail.failureKind, 'unverified')
        assert.ok(detail.errorMessage)
        const listed = await (await fetch(url)).json()
        assert.ok(JSON.stringify(listed).includes('failureKind'))
        assert.ok(!JSON.stringify(listed).includes('private-gate-output'))
        const privateDetail = await (await fetch(`${url}/test`)).json()
        assert.equal(privateDetail.verification.gate, null)
        assert.ok(listed.every((t: any) => !t.options && (!t.verification || t.verification.gate === null)))
        assert.equal(detail.verification.verified, false)
        for (const status of ['unverified', 'capped']) {
          const stream = await (await fetch(`${url}/${status}/stream`)).text()
          assert.match(stream, /event: error/)
          assert.ok(stream.includes(JSON.stringify(q.getTask(status)!.errorMessage!)))
        }
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: f.repo, prompt: 'PR', maxWallMinutes: 999999 }) })
        assert.equal(response.status, 400)
      } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
    } finally { process.env.PATH = savedPath; f.cleanup() }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})
