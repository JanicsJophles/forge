import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('appendLog resumes NULL logs and preserves exact ordered text', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-null-log-append-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('./schema.js')
  try {
    const { appendLog, getTask } = await import('./queries.js')
    const insert = db.prepare(`
      INSERT INTO tasks (id, repo, branch, prompt, log)
      VALUES (?, 'forge', 'test', 'append regression', ?)
    `)
    const fixtures = [
      { id: 'null-log', initial: null },
      { id: 'empty-log', initial: '' },
      { id: 'text-log', initial: 'Existing café\n' },
    ]
    for (const { id, initial } of fixtures) insert.run(id, initial)
    assert.equal((db.prepare('SELECT log FROM tasks WHERE id = ?').get('null-log') as { log: null }).log, null)

    const chunks = ['', 'first ASCII\n', '世界 🌍 café\n', "'quoted' ?; --\n", 'last']
    for (const { id, initial } of fixtures) {
      let expected = initial ?? ''
      for (const chunk of chunks) {
        appendLog(id, chunk)
        expected += chunk
        assert.equal(getTask(id)?.log, expected)
      }
    }

    const before = db.prepare('SELECT * FROM tasks ORDER BY id').all()
    appendLog("missing' OR 1=1 --", 'must not appear')
    assert.equal(getTask("missing' OR 1=1 --"), undefined)
    assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), before)
  } finally {
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    rmSync(directory, { recursive: true, force: true })
  }
})
