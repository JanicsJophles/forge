import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('history keeps its semantic table in a named keyboard scroll region and wraps outside controls', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const { port } = server.address() as { port: number }
  const html = await (await fetch(`http://127.0.0.1:${port}/history`)).text()
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/)
  assert.match(html, /<div class="table-region" role="region" aria-label="Task history table" tabindex="0">\s*<table><thead>/)
  assert.match(html, /<tbody id="rows"><\/tbody><\/table>\s*<\/div>\s*<div class="paging" role="group" aria-label="History pages">/)
  assert.ok((html.match(/<th>/g) || []).length >= 9)
  for (const heading of ['Outcome', 'Repository', 'Prompt preview', 'Logs', 'Recorded commit', 'Changes', 'Run duration', 'Completed (UTC)']) {
    assert.ok(html.includes('<th>' + heading + '</th>'))
  }
  for (const id of ['refresh', 'newer', 'latest', 'older', 'retry']) {
    assert.match(html.match(/<div class="paging"[\s\S]*?<\/div>/)![0], new RegExp('id="' + id + '"'))
  }
  const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]
  assert.match(css, /\*\{box-sizing:border-box\}/)
  assert.match(css, /form,\.paging\{[^}]*display:flex;flex-wrap:wrap;[^}]*max-width:100%;min-width:0/)
  assert.match(css, /input,select,button\{[^}]*max-width:100%;min-width:0/)
  assert.match(css, /\.table-region\{max-width:100%;overflow-x:auto;/)
  assert.match(css, /\.table-region:focus-visible\{outline:/)
  assert.match(css, /table\{[^}]*min-width:70rem;table-layout:fixed;/)
  assert.match(css, /td,th\{[^}]*overflow-wrap:anywhere/)
  assert.match(css, /\.failure-reason\{white-space:pre-wrap\}/)
  assert.doesNotMatch(css, /user-select|text-overflow|overflow:hidden/)
})
