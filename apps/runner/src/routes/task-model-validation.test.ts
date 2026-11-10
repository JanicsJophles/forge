import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import express from 'express'

interface FakeProc extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: EventEmitter & { end: (...a: unknown[]) => void }
  kill: () => boolean
}

test('POST /tasks validates model and forwards a valid one to the provider argv', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-model-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  childProcess.execFileSync('git', ['init', '-q', '-b', 'main', repo])
  process.env.DATA_DIR = path.join(root, 'data')
  process.env.ALLOWED_REPO_PATHS = root
  process.env.MAX_CONCURRENT_TASKS = '10'
  process.env.MIN_FREE_DISK_MB = '1'
  // Run the agent as the current (non-root) account so executionIdentity needs
  // no getent lookup; only Git discovery runs real child processes.
  process.env.CLAUDE_RUN_USER = os.userInfo().username

  const spawnCalls: { command: string; args: string[] }[] = []
  const procs: FakeProc[] = []
  const originalSpawn = childProcess.spawn
  const originalExec = childProcess.execSync
  childProcess.execSync = (() => '') as typeof childProcess.execSync
  childProcess.spawn = ((command: string, args: string[]) => {
    spawnCalls.push({ command, args })
    const proc = new EventEmitter() as FakeProc
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    const stdin = new EventEmitter() as FakeProc['stdin']
    stdin.end = () => {}
    proc.stdin = stdin
    proc.kill = () => true
    procs.push(proc)
    return proc
  }) as typeof childProcess.spawn
  syncBuiltinESMExports()

  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  const app = express().use(express.json()).use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as import('node:net').AddressInfo
  async function post(body: Record<string, unknown>) {
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, prompt: 'test', branch: 'main', ...body }),
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }

  try {
    // Malformed models are rejected before any task row is created.
    for (const model of ['', '-flag', 'has space', 'bad;rm', 'a'.repeat(101), 42]) {
      const bad = await post({ model, provider: 'claude' })
      assert.equal(bad.status, 400, `model ${JSON.stringify(model)} should be rejected`)
    }
    assert.equal((db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n, 0)
    assert.equal(spawnCalls.length, 0)

    // A valid model launches claude with the flag as a separate argv token.
    const ok = await post({ model: 'claude-haiku-4-5', provider: 'claude' })
    assert.equal(ok.status, 201)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(spawnCalls.length, 1)
    assert.equal(spawnCalls[0].command, 'claude')
    assert.deepEqual(spawnCalls[0].args, [
      '--dangerously-skip-permissions', '--model', 'claude-haiku-4-5', '-p', 'test',
    ])
  } finally {
    // Close the fake child so runTask clears its flush interval and settles.
    for (const proc of procs) proc.emit('close', 0, null)
    await new Promise(resolve => setImmediate(resolve))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    childProcess.spawn = originalSpawn
    childProcess.execSync = originalExec
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
