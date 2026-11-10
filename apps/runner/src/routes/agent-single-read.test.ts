import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('single checkpoint reads select only the exact primary key, including expired identities', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'forge-single-agent-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('../db/schema.js')
  const { checkpoint, getAgentState } = await import('../db/agent-state.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const expected = new Map<string, ReturnType<typeof checkpoint>>()
    for (const agentId of ['live', 'expired', 'worker /?#% 雪', "x' OR 1=1 --"]) {
      expected.set(agentId, checkpoint({
        agentId, agentType: 'forge', repo: 'forge', branch: 'fleet/forge/test',
        intent: 'read one', filesTouched: ['src/one.ts'], ticket: 'F-1', status: 'editing',
        metadata: { nested: { value: 42 } },
      }))
    }
    db.prepare('UPDATE agent_state SET expires_at = ? WHERE agent_id = ?').run('2000-01-01 00:00:00', 'expired')
    expected.get('expired')!.expiresAt = '2000-01-01 00:00:00'
    const insert = db.prepare(`INSERT INTO agent_state
      (agent_id, agent_type, expires_at, metadata, files_touched) VALUES (?, 'forge', ?, ?, ?)`)
    const large = JSON.stringify({ data: 'x'.repeat(64 * 1024) })
    db.transaction(() => {
      for (let index = 0; index < 128; index++) {
        insert.run(`unrelated-${index}`, index % 2 ? '2000-01-01' : '2999-01-01', large, '["large.ts"]')
      }
    })()

    // Reject board-list SELECTs outright: unrelated payloads must never be selected
    // or parsed, regardless of how many historical checkpoints exist.
    const prepare = db.prepare.bind(db)
    const selections: string[] = []
    t.mock.method(db, 'prepare', (sql: string) => {
      if (/\bSELECT\b.*\bFROM\s+agent_state\b/is.test(sql)) {
        selections.push(sql)
        assert.match(sql, /^SELECT \* FROM agent_state WHERE agent_id = \?$/)
      }
      return prepare(sql)
    })
    for (const [agentId, row] of expected) {
      assert.deepEqual(getAgentState(agentId), row)
      const response = await fetch(`http://127.0.0.1:${port}/agent-state/${encodeURIComponent(agentId)}`)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), row)
    }
    for (const agentId of ['missing', 'Live', ' live ', 'unrelated-%']) {
      assert.equal(getAgentState(agentId), undefined)
      const response = await fetch(`http://127.0.0.1:${port}/agent-state/${encodeURIComponent(agentId)}`)
      assert.equal(response.status, 404)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      assert.deepEqual(await response.json(), { error: 'not found' })
    }
    assert.equal(selections.length, 16)
  } finally {
    t.mock.restoreAll()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(directory, { recursive: true, force: true })
  }
})
