import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'

test('saved prompt disclosure escapes whitespace and bounds SQLite UTF-8 projection independently of transcript', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-log-prompt-'))
  process.env.DATA_DIR = directory
  process.env.DOTENV_CONFIG_PATH = path.join(directory, 'no-env-file')
  const { db } = await import('../db/schema.js')
  const { taskLogViewRouter } = await import('./task-log-view.js')
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
  const insert = db.prepare(`INSERT INTO tasks (id, repo, branch, prompt, log) VALUES (?, ?, 'test', ?, ?)`)
  insert.run('markup', '/repo', '\n  first\n\t<script>"x" & \'y\'</script>', '')
  insert.run('empty', '/repo', '', '')
  insert.run('legacy', '/repo', '', '')
  const limit = 16384
  for (let remaining = 0; remaining < 4; remaining++) {
    insert.run(`unicode-${remaining}`, '/repo', 'a'.repeat(limit - remaining) + '😀TAIL', 'PRIVATE_TRANSCRIPT'.repeat(1024 * 1024))
  }
  insert.run('exact', '/repo', 'é'.repeat(limit / 2), '')
  // A nullable legacy schema must also be safe, even though current inserts require prompt.
  db.exec('ALTER TABLE tasks RENAME COLUMN prompt TO original_prompt; ALTER TABLE tasks ADD COLUMN prompt TEXT')
  db.exec('UPDATE tasks SET prompt = original_prompt')
  db.prepare('UPDATE tasks SET prompt = NULL WHERE id = ?').run('legacy')
  const prepare = db.prepare.bind(db)
  let reads = 0
  db.prepare = ((sql: string) => {
    assert.doesNotMatch(sql, /SELECT\s+\*|\blog\b/i)
    assert.match(sql, /substr\(CAST\(prompt AS BLOB\), 1, 16384\)/)
    const statement = prepare(sql)
    const get = statement.get.bind(statement)
    statement.get = ((...args: any[]) => {
      const row = get(...args) as { prompt_prefix: Buffer | null }
      if (row?.prompt_prefix) assert.ok(row.prompt_prefix.byteLength <= limit)
      reads++
      return row
    }) as typeof statement.get
    return statement
  }) as typeof db.prepare
  t.after(() => { db.prepare = prepare })
  const server = express().use('/tasks', taskLogViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const page = async (id: string) => (await fetch(`http://127.0.0.1:${address.port}/tasks/${id}/log/view`)).text()
  const markup = await page('markup')
  assert.match(markup, /<details class="saved-prompt"><summary>Saved prompt<\/summary>/)
  assert.ok(markup.includes('<pre>\n\n  first\n\t&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;'))
  assert.match(markup, /white-space: pre-wrap/)
  assert.doesNotMatch(markup, /Additional prompt content omitted/)
  assert.match(await page('empty'), /No saved prompt available\./)
  assert.match(await page('legacy'), /No saved prompt available\./)
  for (let remaining = 0; remaining < 4; remaining++) {
    const html = await page(`unicode-${remaining}`)
    assert.ok(html.includes(`<pre>\n${'a'.repeat(limit - remaining)}</pre>`))
    assert.doesNotMatch(html, /�|TAIL|PRIVATE_TRANSCRIPT/)
    assert.match(html, /Additional prompt content omitted/)
    assert.ok(html.includes(`href="/tasks/unicode-${remaining}?view=detail">Full task detail JSON`))
    assert.ok(Buffer.byteLength(html) < 40000)
  }
  const exact = await page('exact')
  assert.ok(exact.includes('é'.repeat(limit / 2)))
  assert.doesNotMatch(exact, /Additional prompt content omitted/)
  assert.equal(reads, 8)
})
