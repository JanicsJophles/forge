import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('/agent-events validates PR numbers before inserting event rows', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-event-validation-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = dataDir
  const { db } = await import('../db/schema.js')
  const { listEvents } = await import('../db/agent-state.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(express.json()).use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const url = `http://127.0.0.1:${port}/agent-events`
    const post = (body: string) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    // Raw JSON preserves overflow literals: JSON.stringify(Infinity) would send null.
    const invalid = ['"42"', 'true', 'false', '0', '-1', '1.5', '1e309', '-1e309', '9007199254740992', '{}', '[]']
    for (const value of invalid) {
      const response = await post(`{"eventType":"pr_opened","prNumber":${value}}`)
      assert.equal(response.status, 400, value)
      assert.match(response.headers.get('content-type') ?? '', /application\/json/)
      assert.deepEqual(await response.json(), { error: 'prNumber must be a positive safe integer' })
      assert.deepEqual(listEvents(), [], `invalid value ${value} must not create a row`)
    }
    for (const prNumber of [1, 42, Number.MAX_SAFE_INTEGER]) {
      const response = await post(JSON.stringify({ eventType: 'pr_opened', repo: 'owner/forge', prNumber }))
      assert.equal(response.status, 201)
      const event = await response.json()
      assert.equal(event.prNumber, prNumber)
      assert.equal(listEvents().find(row => row.id === event.id)?.prNumber, prNumber)
    }
    for (const body of [{ eventType: 'started' }, { eventType: 'started', prNumber: null }]) {
      const response = await post(JSON.stringify(body))
      assert.equal(response.status, 201)
      assert.equal((await response.json()).prNumber, null)
    }
    assert.equal(listEvents().length, 5)
    const filtered = await fetch(`${url}?repo=owner%2Fforge&type=pr_opened`)
    assert.equal(filtered.status, 200)
    assert.equal((await filtered.json()).length, 3)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})
