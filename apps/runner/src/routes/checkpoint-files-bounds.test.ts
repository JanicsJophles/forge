import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('checkpoint file claims enforce serialized UTF-8 bounds before any writes', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'forge-checkpoint-files-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = dataDir
  const { db } = await import('../db/schema.js')
  const { agentStateRouter } = await import('./agent-state.js')
  const server = express().use(express.json({ limit: '2mb' })).use(agentStateRouter).listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const { port } = server.address() as { port: number }
    const url = `http://127.0.0.1:${port}`
    const post = (body: Record<string, unknown>) => fetch(url + '/agent-state/checkpoint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const get = async (route: string) => {
      const response = await fetch(url + route)
      assert.equal(response.status, 200)
      return response.json()
    }
    const roundTrip = async (patch: Record<string, unknown>, expected: string[] | null) => {
      const response = await post({ agentId: 'worker', repo: 'forge', ...patch })
      assert.equal(response.status, 200)
      const state = await response.json()
      assert.deepEqual(state.filesTouched, expected)
      assert.deepEqual(await get('/agent-state/worker'), state)
      assert.deepEqual((await get('/agent-context?repo=forge')).liveAgents, [state])
    }
    const boundaries = [
      ['x'.repeat(16380)],
      [...Array<string>(4095).fill('x'), ''],
      ['😀'.repeat(4095)],
      ['"\\\n'.repeat(2730)],
    ]
    for (const filesTouched of boundaries) {
      assert.equal(Buffer.byteLength(JSON.stringify(filesTouched), 'utf8'), 16384)
      await roundTrip({ filesTouched }, filesTouched)
      // Filtering happens before sizing, even for large discarded objects.
      await roundTrip({ filesTouched: [null, ...filesTouched, 42, { ignored: 'z'.repeat(20000) }] }, filesTouched)
      await roundTrip({ intent: 'retained' }, filesTouched)
      for (const oversized of [
        [filesTouched[0] + 'x', ...filesTouched.slice(1)],
        ['x'.repeat(20000)],
        Array<string>(6000).fill('a'),
      ]) {
        assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > 16384)
        for (const agentId of ['worker', 'new-worker']) {
          const before = db.prepare('SELECT * FROM agent_state').all()
          const response = await post({ agentId, filesTouched: oversized, intent: 'must not persist', metadata: { changed: true } })
          assert.equal(response.status, 400)
          assert.deepEqual(await response.json(), { error: 'checkpoint payload exceeds field size limits' })
          assert.deepEqual(db.prepare('SELECT * FROM agent_state').all(), before)
        }
      }
    }
    await roundTrip({ filesTouched: [] }, [])
    await roundTrip({ filesTouched: [false, null, 42, {}] }, [])
    await roundTrip({ filesTouched: ['é/😀', 'quote"slash\\line\n', 'same', 'same', ''] },
      ['é/😀', 'quote"slash\\line\n', 'same', 'same', ''])
    await roundTrip({ filesTouched: null }, null)
    await roundTrip({}, null)
    const response = await post({ agentId: 'empty', filesTouched: null })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).filesTouched, null)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})
