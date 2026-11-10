import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('history renders saved launch settings as text from a single list request', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve())
    server.closeAllConnections()
  }))
  const { port } = server.address() as { port: number }
  const html = await (await fetch(`http://127.0.0.1:${port}/history`)).text()
  assert.match(html, /<th>Launch settings<\/th>/)
  assert.doesNotMatch(html, /innerHTML/)
  const elements = new Map<string, any>()
  function element() {
    return {
      value: '', textContent: '', disabled: false, hidden: false, children: [] as any[],
      appendChild(child: any) { this.children.push(child) },
      replaceChildren(...children: any[]) { this.children = children },
    }
  }
  const fixtures = [
    { provider: 'claude', model: 'opus', autoCommit: true },
    { provider: 'codex', autoCommit: false },
    {},
    { provider: 'claude', model: '', autoCommit: false },
    { provider: 'codex', model: 'gpt-5', autoCommit: true },
    { provider: '<img src=x onerror=evil()>', model: '</td><script>evil()</script>' },
  ]
  const requests: string[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      },
      createElement: element,
    },
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (url: string) => {
      requests.push(url)
      return {
        ok: true, headers: { get: () => null },
        json: async () => fixtures.map((settings, id) => ({
          id: String(id), status: 'completed', repo: '/offline', prompt: 'fixture', ...settings,
        })),
      }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requests, ['/tasks?limit=25'])
  const rows = elements.get('rows').children
  assert.equal(rows.length, fixtures.length)
  const expected = [
    'Provider: claude · Model: opus · Auto-commit: on',
    'Provider: codex · Model: provider default · Auto-commit: off',
    'Provider: unspecified · Model: provider default · Auto-commit: unspecified',
    'Provider: claude · Model: provider default · Auto-commit: off',
    'Provider: codex · Model: gpt-5 · Auto-commit: on',
    'Provider: <img src=x onerror=evil()> · Model: </td><script>evil()</script> · Auto-commit: unspecified',
  ]
  for (const [index, row] of rows.entries()) {
    const cell = row.children.at(-1)
    assert.equal(cell.textContent, expected[index])
    assert.equal(cell.children.length, 0)
    assert.equal(row.children[4].children[0].href, `/tasks/${index}/log/view`)
  }
})
