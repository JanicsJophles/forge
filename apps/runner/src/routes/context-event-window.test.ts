import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('/agent-context discloses the bounded newest-first event window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-context-window-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('../db/schema.js')
  const { checkpoint } = await import('../db/agent-state.js')
  const { insertTask } = await import('../db/queries.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const since = new Date().toISOString().slice(0, 10) + ' 12:00:00'
    const get = async (bound = since) => {
      const response = await fetch(`http://127.0.0.1:${port}/agent-context?since=${encodeURIComponent(bound)}`)
      assert.equal(response.status, 200)
      return response.json()
    }
    checkpoint({ agentId: 'fixture', repo: 'forge', ticket: 'FORGE-1' })
    insertTask({
      id: 'fixture', repo: 'forge', branch: 'test', prompt: 'fixture',
      status: 'queued', log: '', createdAt: new Date().toISOString(),
    })
    const insert = db.prepare('INSERT INTO agent_events (event_type, created_at) VALUES (?, ?)')
    for (const count of [0, 199, 200, 201, 250]) {
      db.prepare('DELETE FROM agent_events').run()
      const ids: number[] = []
      for (let index = 0; index < count; index++) {
        ids.push(Number(insert.run('fixture', since).lastInsertRowid))
      }
      // Higher IDs with older timestamps must neither fill nor truncate the window.
      for (let index = 0; index < 202; index++) insert.run('excluded', since.replace('12:00:00', '11:59:59'))
      const snapshot = await get()
      const expected = ids.slice().reverse().slice(0, 200)
      assert.deepEqual(snapshot.recentEvents.map((event: { id: number }) => event.id), expected)
      assert.equal(snapshot.recentEventsCount, expected.length)
      assert.equal(snapshot.recentEventsTruncated, count > 200)
      assert.equal(snapshot.recentEventsOldestId, expected.at(-1) ?? null)
      assert.equal(snapshot.since, since)
      assert.equal(snapshot.liveAgentsCount, 1)
      assert.equal(snapshot.liveAgents.length, 1)
      assert.deepEqual(snapshot.liveByRepo, { forge: 1 })
      assert.deepEqual(snapshot.liveByTicket, { 'FORGE-1': 1 })
      assert.equal(snapshot.liveTasksCount, 1)
      assert.equal(snapshot.liveTasks.length, 1)
      assert.deepEqual(snapshot.liveTasksByRepo, { forge: 1 })
    }
    const empty = await get(since.replace('12:00:00', '12:00:01'))
    assert.deepEqual(empty.recentEvents, [])
    assert.equal(empty.recentEventsCount, 0)
    assert.equal(empty.recentEventsTruncated, false)
    assert.equal(empty.recentEventsOldestId, null)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(directory, { recursive: true, force: true })
  }
})
