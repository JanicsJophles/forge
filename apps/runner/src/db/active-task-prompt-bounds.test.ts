import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('active summaries select bounded prompt bytes and preserve full execution reads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-active-prompt-'))
  const previous = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const { db } = await import('./schema.js')
  const { listActiveTasks, getTask, ACTIVE_PROMPT_MAX_BYTES: cap } = await import('./queries.js')
  const prepare = db.prepare
  try {
    const prompts = new Map([
      ['huge', 'x'.repeat(2 * 1024 * 1024)],
      ['spaces', ' '.repeat(2 * 1024 * 1024) + 'hidden work'],
      ['split', ' '.repeat(cap - 1) + '€ after'],
      ['unicode', '😀'.repeat(100)],
      ['short', '  hello\n 世界 😀  '],
      ['empty', ''],
      ['exact', ' '.repeat(cap - 4) + 'done'],
    ])
    const insert = db.prepare(`INSERT INTO tasks
      (id, repo, branch, prompt, status, log, created_at)
      VALUES (?, ?, 'test', ?, ?, ?, '2026-11-09 12:00:00')`)
    for (const [id, prompt] of prompts) {
      insert.run(id, id === 'short' ? '/other' : '/repo', prompt,
        id === 'short' ? 'running' : 'queued', 'large log'.repeat(100000))
    }
    for (const status of ['completed', 'failed']) insert.run(status, '/repo', 'terminal', status, '')

    // Inspect the actual values returned by SQLite to catch unbounded reads even
    // when the final public snippet would still look correct.
    const selected: Record<string, unknown>[] = []
    db.prepare = function (sql: string) {
      const statement = prepare.call(db, sql)
      if (sql.includes('AS prompt_head')) {
        const all = statement.all.bind(statement)
        statement.all = (...args: unknown[]) => {
          const rows = all(...args) as Record<string, unknown>[]
          selected.push(...rows)
          return rows
        }
      }
      return statement
    } as typeof db.prepare
    const summaries = listActiveTasks()
    db.prepare = prepare
    assert.deepEqual(summaries.map(row => row.id), [...prompts.keys()].reverse())
    assert.equal(selected.length, prompts.size)
    for (const row of selected) {
      const head = row.prompt_head ?? Buffer.alloc(0) // SQLite returns NULL for an empty BLOB slice.
      assert.ok(Buffer.isBuffer(head))
      assert.ok(head.length <= cap)
      assert.deepEqual(head, Buffer.from(prompts.get(row.id as string)!).subarray(0, cap))
      assert.equal(row.prompt_bytes, Buffer.byteLength(prompts.get(row.id as string)!))
      assert.deepEqual(Object.keys(row).sort(), [
        'id', 'repo', 'branch', 'status', 'provider', 'created_at', 'prompt_head', 'prompt_bytes',
      ].sort())
    }
    const snippets = Object.fromEntries(summaries.map(row => [row.id, row.promptSnippet]))
    assert.equal(snippets.huge, 'x'.repeat(119) + '…')
    assert.equal(snippets.spaces, '…')
    assert.equal(snippets.split, '…')
    assert.equal(snippets.unicode, '😀'.repeat(59) + '…')
    assert.equal(snippets.short, 'hello 世界 😀')
    assert.equal(snippets.empty, '')
    assert.equal(snippets.exact, 'done')
    assert.equal(summaries.find(row => row.id === 'short')!.repo, '/other')
    for (const row of summaries) {
      assert.ok(row.promptSnippet.length <= 120)
      assert.equal(row.promptSnippet.includes('\uFFFD'), false)
      assert.equal(getTask(row.id)!.prompt, prompts.get(row.id))
      assert.deepEqual(Object.keys(row).sort(), [
        'id', 'repo', 'branch', 'status', 'provider', 'createdAt', 'promptSnippet',
      ].sort())
    }
  } finally {
    db.prepare = prepare
    db.close()
    if (previous === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
