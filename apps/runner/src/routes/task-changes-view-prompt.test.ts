import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import express from 'express'

test('review renders a literal, collapsed saved prompt with a SQL byte bound', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-prompt-'))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo])
  process.env.DATA_DIR = path.join(root, 'data')
  const { taskChangesViewRouter } = await import('./task-changes-view.js')
  const { db } = await import('../db/schema.js')
  const server = express().use('/tasks', taskChangesViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const id = 'task <&"'
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/tasks/${encodeURIComponent(id)}/changes/view`
  const prepare = db.prepare.bind(db)
  const queries: string[] = []
  db.prepare = ((sql: string) => { queries.push(sql); return prepare(sql) }) as typeof db.prepare
  const setPrompt = (prompt: string) => prepare('UPDATE tasks SET prompt = ? WHERE id = ?').run(prompt, id)
  const html = async () => {
    queries.length = 0
    const response = await fetch(url)
    assert.equal(response.status, 200)
    const result = await response.text()
    assert.equal(queries.length, 1)
    assert.match(queries[0], /substr\(CAST\(prompt AS BLOB\), 1, 16384\) AS prompt_prefix/)
    assert.match(queries[0], /length\(CAST\(prompt AS BLOB\)\) AS prompt_bytes/)
    assert.doesNotMatch(queries[0], /SELECT\s+\*|\blog\b|SELECT\s+prompt\b|,\s*prompt\s*[,\n]/i)
    assert.match(result, /<details>\s*<summary>Saved prompt<\/summary>/)
    assert.doesNotMatch(result, /<details[^>]*\bopen\b|PRIVATE_LOG/)
    return result
  }
  try {
    prepare('INSERT INTO tasks (id, repo, branch, prompt, log) VALUES (?, ?, ?, ?, ?)')
      .run(id, repo, 'test', '', 'PRIVATE_LOG'.repeat(10000))
    assert.match(await html(), /No saved prompt is available/)
    setPrompt('<script>alert("x")</script>&\'\n**literal**')
    let result = await html()
    assert.match(result, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;&amp;&#39;\n\*\*literal\*\*/)
    assert.doesNotMatch(result, /<script>|Prompt truncated/)
    setPrompt('x'.repeat(16384))
    assert.doesNotMatch(await html(), /Prompt truncated/)
    for (const suffix of ['é', '€', '😀']) {
      setPrompt('x'.repeat(16383) + suffix + 'OMITTED_TAIL')
      result = await html()
      assert.match(result, /Prompt truncated: showing at most 16384 UTF-8 bytes/)
      assert.match(result, /detail JSON/)
      assert.ok(result.includes(`href="/tasks/${encodeURIComponent(id)}"`))
      assert.doesNotMatch(result, /OMITTED_TAIL|�|é|€|😀/)
      assert.match(result, new RegExp('x{16383}</pre>'))
    }
    setPrompt('😀'.repeat(10000))
    result = await html()
    assert.match(result, new RegExp('😀{4096}</pre>', 'u'))
    assert.doesNotMatch(result, /�/)
  } finally {
    db.prepare = prepare
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
