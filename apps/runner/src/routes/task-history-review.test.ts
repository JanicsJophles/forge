import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('history reviews saved reasons, commits and changes using only list responses', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve())
    server.closeAllConnections()
  }))
  const { port } = server.address() as { port: number }
  const html = await (await fetch(`http://127.0.0.1:${port}/history`)).text()
  assert.doesNotMatch(html, /innerHTML/)
  assert.match(html, /<th>Recorded commit<\/th><th>Changes<\/th>/)
  function element(tag = '') {
    return { tag, value: '', textContent: '', disabled: false, hidden: false, children: [] as any[],
      appendChild(child: any) { this.children.push(child) },
      replaceChildren(...children: any[]) { this.children = children },
    }
  }
  const elements = new Map<string, any>()
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, element())
    return elements.get(id)
  }
  const requests: { url: string; resolve: (value: any) => void; reject: (error: Error) => void }[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById: el, createElement: element }, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: (url: string) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
  })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const answer = async (tasks: any[], next: string | null = null) => {
    requests.at(-1)!.resolve({ ok: true, json: async () => tasks,
      headers: { get: () => next } })
    await tick()
  }
  const hostile = '<img src=x onerror="evil()">&<script>evil()</script>'
  const task = (id: any, extra = {}) => ({ id, status: 'failed', createdAt: '2026-11-09',
    repo: '/repo', prompt: 'preview', ...extra })
  await answer([
    task('failed-with-reason', { errorMessage: hostile, commitSha: 'abcdef1234567890' }),
    task('failed-without-reason'),
    task('completed', { status: 'completed', errorMessage: 'ignore', commitSha: '1234567890abcdef' }),
    task(hostile, { errorMessage: hostile, commitSha: hostile, repo: hostile, prompt: hostile }),
    ...['../other', '%2e', 'a/b', 'a?x=1'].map(id => task(id)),
  ], 'older-cursor')
  let rows = el('rows').children
  assert.equal(rows[0].children[0].textContent, 'failed')
  assert.equal(rows[0].children[0].children[0].textContent, hostile)
  assert.equal(rows[0].children[0].children[0].tag, 'div')
  assert.equal(rows[0].children[0].children[0].children.length, 0)
  assert.equal(rows[0].children[5].textContent, 'abcdef1')
  assert.equal(rows[0].children[6].children[0].href, '/tasks/failed-with-reason/changes/view')
  assert.equal(rows[0].children[6].children[0].textContent, 'Changes')
  assert.equal(rows[1].children[0].children.length, 0)
  assert.equal(rows[1].children[5].textContent, '')
  assert.equal(rows[1].children[6].children.length, 1)
  assert.equal(rows[2].children[0].children.length, 0)
  assert.equal(rows[2].children[5].textContent, '1234567')
  assert.equal(rows[3].children[5].textContent, hostile.slice(0, 7))
  assert.equal(rows[3].children[2].textContent, hostile)
  assert.equal(rows[3].children[3].textContent, hostile)
  for (const [index, id] of [hostile, '../other', '%2e', 'a/b', 'a?x=1'].entries()) {
    assert.equal(rows[index + 3].children[6].children[0].href,
      '/tasks/' + encodeURIComponent(id) + '/changes/view')
  }
  assert.equal(requests.length, 1, 'no task detail or transcript requests')

  el('older').onclick()
  assert.equal(new URL(requests.at(-1)!.url, 'http://fake').searchParams.get('before'), 'older-cursor')
  await answer([task('older', { errorMessage: 'older failure' })])
  rows = el('rows').children
  assert.equal(rows.length, 1)
  assert.equal(rows[0].children[0].children[0].textContent, 'older failure')
  assert.equal(rows[0].children[5].textContent, '')
  assert.equal(rows[0].children[6].children[0].href, '/tasks/older/changes/view')
  el('repo').value = '/filtered?&'
  el('repo').onchange()
  el('status').value = 'completed'
  el('status').onchange()
  const query = new URL(requests.at(-1)!.url, 'http://fake').searchParams
  assert.equal(query.get('repo'), '/filtered?&')
  assert.equal(query.get('status'), 'completed')
  assert.equal(query.has('before'), false)
  await answer([task('filtered', { status: 'completed', commitSha: '7654321abcdef' })])
  // An earlier filter response must not replace the latest review fields.
  requests.at(-2)!.resolve({ ok: true, json: async () => [task('stale')], headers: { get: () => null } })
  await tick()
  assert.equal(el('rows').children[0].children[5].textContent, '7654321')
  assert.equal(el('rows').children[0].children[6].children[0].href, '/tasks/filtered/changes/view')
  assert.equal(requests.length, 4)
  assert.ok(requests.every(request => request.url.startsWith('/tasks?')))
})
