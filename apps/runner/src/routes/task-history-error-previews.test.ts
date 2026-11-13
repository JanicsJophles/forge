import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('history bounds failure diagnostics and retains context links across rerenders and failed navigation', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const { port } = server.address() as { port: number }
  const html = await (await fetch(`http://127.0.0.1:${port}/history`)).text()
  assert.doesNotMatch(html, /innerHTML/)
  assert.match(html, /\.failure-reason\{white-space:pre-wrap\}/)
  const elements = new Map<string, any>()
  const element = (tag = '') => ({ tag, value: '', textContent: '', disabled: false, hidden: false,
    children: [] as any[], appendChild(child: any) { this.children.push(child) },
    replaceChildren(...children: any[]) { this.children = children } })
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, element())
    return elements.get(id)
  }
  const requests: { url: string; resolve: (value: any) => void }[] = []
  let location = new URL('http://fake/history?repo=%2Fsaved%3F%26&status=failed&provider=codex&before=anchor')
  const listeners: Record<string, () => any> = {}
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { createElement: element, getElementById: el }, URLSearchParams, AbortController, setTimeout, clearTimeout,
    window: { get location() { return location }, history: { pushState(_a: any, _b: any, url: string) {
      location = new URL(url, location)
    } }, addEventListener(name: string, fn: () => any) { listeners[name] = fn } },
    fetch: (url: string) => new Promise(resolve => requests.push({ url, resolve })),
  })
  const answer = async (tasks: unknown, ok = true) => {
    requests.at(-1)!.resolve({ ok, status: ok ? 200 : 503, json: async () => tasks, headers: { get: () => 'older' } })
    await new Promise(resolve => setImmediate(resolve))
  }
  const hostile = '<img src=x onerror="evil()">\n<script>evil()</script>'
  const prefix = '🧠'.repeat(499) + '\n'
  const diagnostics = [prefix + '🚀'.repeat(2000), hostile, undefined, null, '', ' \n ', '🚀'.repeat(500)]
  const tasks = diagnostics.map((errorMessage, i) => ({ id: ` task/${i}?%2F&🧠 `, status: 'failed', errorMessage }))
  const check = () => {
    for (const [i, task] of tasks.entries()) {
      const row = el('rows').children[i]
      const outcome = row.children[0]
      const reason = outcome.children[0]
      assert.equal(reason.className, 'failure-reason')
      assert.equal(reason.children.length, 0, 'diagnostics remain literal text')
      assert.equal(reason.textContent, i === 0 ? prefix : task.errorMessage?.trim()
        ? task.errorMessage : 'No saved failure reason is available.')
      if (i === 0) assert.match(outcome.children[1].textContent, /truncated.*500 Unicode code points/)
      else assert.equal(outcome.children.length, 2, 'short and exact-boundary reasons are not truncated')
      const link = outcome.children.at(-1)
      const path = '/tasks/' + encodeURIComponent(task.id)
      assert.equal(link.tag, 'a')
      assert.equal(link.textContent, 'Full saved failure context')
      assert.equal(link.href, path + '/log/view')
      assert.equal(row.children[4].children[2].href, path + '/log?format=text&download=1')
    }
    assert.equal(tasks[0].errorMessage, prefix + '🚀'.repeat(2000), 'saved diagnostics are unchanged')
  }
  await answer(tasks); check()
  el('refresh').onclick(); await answer(tasks); check()
  const retained = el('rows').children
  for (const malformed of [[...tasks, { ...tasks[0], errorMessage: {} }], null]) {
    el('refresh').onclick(); await answer(malformed)
    assert.equal(el('rows').children, retained)
    check()
    assert.match(el('displayed').textContent, /Stale.*Repository: \/saved\?&; Status: failed; Page 2.*anchor.*Provider: codex/)
  }
  el('repo').value = '/unavailable'; el('repo').onchange(); await answer([], false)
  assert.equal(location.searchParams.get('repo'), '/unavailable')
  assert.equal(el('rows').children, retained); check()
  el('refresh').onclick()
  const query = new URL(requests.at(-1)!.url, 'http://fake').searchParams
  assert.equal(query.get('repo'), '/saved?&')
  assert.equal(query.get('status'), 'failed')
  assert.equal(query.get('provider'), 'codex')
  assert.equal(query.get('before'), 'anchor')
  await answer(tasks); check()
  location = new URL('http://fake/history?repo=%2Fsaved%3F%26&status=failed&provider=codex&before=anchor')
  listeners.popstate(); await answer(tasks); check()
  assert.equal(requests.length, 7, 'one list request per navigation; no per-row requests')
  assert.ok(requests.every(request => request.url.startsWith('/tasks?')))
})
