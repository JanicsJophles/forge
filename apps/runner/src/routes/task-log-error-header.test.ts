import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('GET/HEAD /:id/log surface a failed task reason via X-Task-Error', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-log-error-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { taskLogRouter } = await import('./task-log.js')
  const { tasksRouter } = await import('./tasks.js')
  const { db } = await import('../db/schema.js')
  t.after(() => db.close())
  const insert = db.prepare(
    'INSERT INTO tasks (id, repo, branch, prompt, status, log, error_message) VALUES (?, \'/fake\', \'test\', \'test\', ?, ?, ?)')
  // A newline-bearing message tests both the single-line guarantee and that a
  // CRLF cannot inject a second header; the tail makes it exceed the 200 cap.
  const injection = 'boom\r\nX-Injected: evil\nsecond line' + 'a'.repeat(300)
  insert.run('failed', 'failed', 'log body\n', 'agent process exited with code 1')
  insert.run('failed-newline', 'failed', 'log body\n', injection)
  insert.run('failed-nomsg', 'failed', 'log body\n', null)
  insert.run('done', 'done', 'log body\n', null)

  const cases = [
    ['emoji', 'agent 💥 failed', 'agent   failed'],
    ['dash', 'agent—failed', 'agent failed'],
    ['nul', 'agent\0failed', 'agent failed'],
    ['controls', 'agent\t\x01\x7f failed', 'agent  failed'],
    ['ascii', 'exit 1: [failed]!', 'exit 1: [failed]!'],
    ['unicode-long', '💥'.repeat(300) + 'x'.repeat(300), 'x'.repeat(199)],
  ]
  for (const [id, original] of cases) insert.run(id, 'failed', 'log body\n', original)

  const app = express().use('/tasks', taskLogRouter).use('/tasks', tasksRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()))
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/tasks`

  for (const [id, original] of [...cases, ['failed-newline', injection]]) {
    const detail = await fetch(`${base}/${id}`)
    assert.equal(detail.status, 200)
    assert.equal((await detail.json()).errorMessage, original)
  }

  for (const method of ['GET', 'HEAD'] as const) {
    async function fetchLog(id: string) {
      const response = await fetch(`${base}/${id}`, { method })
      assert.equal(response.status, 200, `${method} ${id}`)
      await response.arrayBuffer()
      return response
    }

    // Failed with a stored message: header present, carries the message.
    const failed = await fetchLog('failed/log')
    assert.equal(failed.headers.get('x-task-status'), 'failed')
    assert.equal(failed.headers.get('x-task-error'), 'agent process exited with code 1')

    // Newline-bearing message: single line (no CR/LF), bounded, no injected header.
    const newline = await fetchLog('failed-newline/log')
    const value = newline.headers.get('x-task-error')
    assert.ok(value, `${method} expected X-Task-Error`)
    assert.ok(!/[\r\n]/.test(value), `${method} X-Task-Error must be single-line`)
    assert.ok(value.length <= 200, `${method} X-Task-Error must be bounded`)
    assert.equal(value, ('boom X-Injected: evil second line' + 'a'.repeat(300)).slice(0, 200))
    assert.equal(newline.headers.get('x-injected'), null)

    for (const [id, , expected] of cases) {
      for (const query of ['', '?format=text', '?format=text&download=1', '?tailLines=1', '?tailLines=1&format=text']) {
        const response = await fetchLog(id + '/log' + query)
        assert.equal(response.headers.get('x-task-status'), 'failed')
        assert.equal(response.headers.get('x-task-error'), expected)
        assert.ok(/^[\x20-\x7e]{1,200}$/.test(response.headers.get('x-task-error')!))
      }
    }

    // Failed but no stored message: header absent.
    const noMessage = await fetchLog('failed-nomsg/log')
    assert.equal(noMessage.headers.get('x-task-status'), 'failed')
    assert.equal(noMessage.headers.get('x-task-error'), null)

    // Non-failed task: header absent even though status is terminal.
    const done = await fetchLog('done/log')
    assert.equal(done.headers.get('x-task-status'), 'done')
    assert.equal(done.headers.get('x-task-error'), null)
  }
})
