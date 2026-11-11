import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('expired anchors recover explicitly with retained filters and fence superseded responses', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const { port } = server.address() as { port: number }
  const html = await (await fetch(`http://127.0.0.1:${port}/history`)).text()
  function fixture(search = '') {
    const elements = new Map<string, any>()
    const element = () => ({ value: '', textContent: '', disabled: false, hidden: false, children: [] as any[],
      appendChild(child: any) { this.children.push(child) }, replaceChildren(...children: any[]) { this.children = children } })
    const requests: { url: string; resolve: (value: any) => void }[] = []
    const location = new URL('/history' + search, 'http://fake')
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
      window: { location, history: { pushState() {} }, addEventListener() {} },
      document: { getElementById(id: string) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) }, createElement: element },
      URLSearchParams, AbortController, setTimeout, clearTimeout,
      fetch: (url: string) => new Promise(resolve => requests.push({ url, resolve })),
    })
    return { el: (id: string) => elements.get(id), requests,
      query: (i: number) => new URL(requests[i].url, 'http://fake').searchParams,
      answer(i: number, id: string, next: string | null = null) { requests[i].resolve({ ok: true, json: async () => [{ id, status: 'completed', branch: 'fleet/example', provider: 'codex', model: 'fixture-model', autoCommit: false, startedAt: '2026-11-10 10:00:00', completedAt: '2026-11-10 10:00:09' }], headers: { get: () => next } }) },
      fail(i: number, status = 404) { requests[i].resolve({ ok: false, status }) },
    }
  }
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const h = fixture()
  h.answer(0, 'initial'); await tick()
  h.el('repo').value = '/repo?&'; h.el('status').value = 'completed'
  h.el('filters').onsubmit({ preventDefault() {} })
  h.answer(1, 'latest', 'older-anchor'); await tick()
  h.el('older').onclick(); h.answer(2, 'older', 'next-anchor'); await tick()
  const retained = h.el('rows').children[0]
  // Also run this fixture with the open history proposals composed in a scratch tree.
  const cells = retained.children.map((cell: any) => cell.textContent)
  if (html.includes('<th>Launch settings</th>')) assert.ok(cells.includes('Provider: codex · Model: fixture-model · Auto-commit: off'))
  if (html.includes('<th>Run duration</th>')) assert.ok(cells.includes('9s'))
  if (html.includes('<th>Task ID</th>')) assert.ok(retained.children.some((cell: any) => cell.children[0]?.textContent === 'older'))
  if (html.includes("branch.textContent = 'Branch: '")) assert.ok(retained.children[2].children.some((child: any) => child.textContent === 'Branch: fleet/example'))

  h.el('refresh').onclick(); h.fail(3); await tick()
  assert.match(h.el('expired').textContent, /page has expired/)
  assert.match(h.el('expired').textContent, /Stale rows/)
  assert.equal(h.el('recover').hidden, false)
  assert.equal(h.el('retry').hidden, true)
  assert.equal(h.el('older').disabled, true)
  // Draft filters must not change the recovery selection.
  h.el('repo').value = '/draft'; h.el('status').value = 'failed'
  h.el('recover').onclick()
  assert.equal(h.query(4).has('before'), false)
  assert.equal(h.query(4).get('repo'), '/repo?&')
  assert.equal(h.query(4).get('status'), 'completed')
  assert.equal(h.el('rows').children[0], retained)
  assert.match(h.el('expired').textContent, /Stale rows/)
  h.fail(4, 503); await tick()
  assert.equal(h.el('recover').disabled, false)
  assert.equal(h.el('rows').children[0], retained)
  h.el('refresh').onclick()
  assert.equal(h.requests[5].url, h.requests[4].url)
  h.answer(5, 'replacement'); await tick()
  assert.equal(h.el('expired').hidden, true)
  assert.equal(h.el('recover').hidden, true)
  assert.notEqual(h.el('rows').children[0], retained)

  const deep = fixture('?before=deleted%3F%26')
  assert.equal(deep.query(0).get('before'), 'deleted?&')
  deep.fail(0); await tick()
  assert.match(deep.el('expired').textContent, /No task history loaded/)
  deep.el('recover').onclick(); deep.fail(1, 503); await tick()
  assert.equal(deep.query(1).has('before'), false)
  deep.el('recover').onclick()
  // A filter request supersedes recovery even if fetch ignores abort.
  deep.el('repo').value = '/new'; deep.el('repo').onchange()
  deep.answer(3, 'new-selection', 'new-anchor'); await tick()
  const newest = deep.el('rows').children[0]
  deep.answer(2, 'late-recovery'); await tick()
  assert.equal(deep.el('rows').children[0], newest)
  deep.el('older').onclick()
  deep.el('repo').value = '/newer'; deep.el('repo').onchange()
  deep.fail(4); await tick()
  assert.equal(deep.el('recover').hidden, true)
  deep.answer(5, 'final'); await tick()
})
