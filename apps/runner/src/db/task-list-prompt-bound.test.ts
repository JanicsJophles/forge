import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { readTaskProjection } from './task-projection.js'

// The list view (GET /tasks) must bound each row's prompt to a leading head so a
// 20-row response can't balloon to tens of MB, while the single-task reads
// (getTask / the detail projection, GET /tasks/:id) still return the full prompt.
test('listTasks bounds the prompt while single-task reads keep it whole', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-prompt-bound-'))
  const previousDataDir = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('./schema.js')
  const { listTasks, getTask, LIST_PROMPT_MAX_BYTES } = await import('./queries.js')
  try {
    const insert = db.prepare(`INSERT INTO tasks
      (id, repo, branch, prompt, status, log, created_at)
      VALUES (?, '/throwaway/repo', 'test', ?, 'queued', '', ?)`)

    // The oversized prompt deliberately places a 3-byte euro sign so that the
    // LIST_PROMPT_MAX_BYTES cut lands inside the codepoint — the head must drop
    // the partial char rather than split it.
    const bigPrefix = 'a'.repeat(LIST_PROMPT_MAX_BYTES - 1)
    const prompts = new Map<string, string>([
      ['empty', ''],
      ['ascii-small', 'deploy the thing'],
      // Exactly at the cap: full prompt fits, nothing truncated.
      ['ascii-exact', 'z'.repeat(LIST_PROMPT_MAX_BYTES)],
      // One byte over the cap in plain ASCII.
      ['ascii-over', 'y'.repeat(LIST_PROMPT_MAX_BYTES + 1)],
      // Cut falls mid-euro: head must stop before the split multibyte char.
      ['unicode-split', bigPrefix + '€' + 'b'.repeat(100)],
    ])
    // Insert newest-last so createdAt ordering is deterministic (not asserted here).
    let second = 0
    for (const [id, prompt] of prompts) {
      insert.run(id, prompt, `2026-11-05 12:00:${String(second++).padStart(2, '0')}`)
    }

    const history = listTasks(prompts.size)
    assert.equal(history.length, prompts.size)

    for (const [id, prompt] of prompts) {
      const fullBytes = Buffer.byteLength(prompt, 'utf8')
      const listed = history.find(task => task.id === id)!
      assert.ok(listed, `missing ${id} in list`)

      // promptBytes always reports the complete length.
      assert.equal(listed.promptBytes, fullBytes, `${id} promptBytes`)
      assert.equal(listed.promptTruncated, fullBytes > LIST_PROMPT_MAX_BYTES, `${id} truncated`)

      // The returned list prompt is always within the byte cap and never a split char.
      assert.ok(
        Buffer.byteLength(listed.prompt, 'utf8') <= LIST_PROMPT_MAX_BYTES,
        `${id} list prompt exceeds cap`,
      )
      assert.equal(listed.prompt.includes('\uFFFD'), false, `${id} has replacement char`)

      if (fullBytes <= LIST_PROMPT_MAX_BYTES) {
        // Small/exact prompts come back whole even in the bounded list view.
        assert.equal(listed.prompt, prompt, `${id} small prompt should be whole`)
      } else {
        assert.ok(prompt.startsWith(listed.prompt), `${id} head must be a prefix`)
      }

      // Single-task reads must return the complete prompt regardless of size.
      const single = getTask(id)!
      assert.equal(single.prompt, prompt, `${id} getTask prompt`)
      assert.equal(single.promptBytes, undefined, `${id} getTask has no promptBytes`)
      assert.equal(single.promptTruncated, undefined, `${id} getTask has no promptTruncated`)

      const detail = readTaskProjection(db, id, 'detail')!
      assert.equal(detail.prompt, prompt, `${id} detail projection prompt`)
    }

    // The mid-euro case specifically: head stops before the split codepoint, so
    // promptTruncated is true and the euro never appears in the bounded prompt.
    const split = history.find(task => task.id === 'unicode-split')!
    assert.equal(split.promptTruncated, true)
    assert.equal(split.prompt, bigPrefix)
    assert.equal(split.prompt.includes('€'), false)
    assert.equal(split.promptBytes, Buffer.byteLength(bigPrefix) + 3 + 100)
  } finally {
    db.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    rmSync(directory, { recursive: true, force: true })
  }
})
