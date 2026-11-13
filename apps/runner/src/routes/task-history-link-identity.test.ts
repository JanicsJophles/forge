import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('history links preserve safe identities and malformed IDs retain the complete successful page', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const { port } = server.address() as { port: number }
  const html = await (await fetch(`http://127.0.0.1:${port}/history`)).text()
  assert.doesNotMatch(html, /innerHTML/)
  const elements = new Map<string, any>()
  const element = (tag = '') => ({ tag, value: '', textContent: '', disabled: false, hidden: false,
    children: [] as any[], appendChild(child: any) { this.children.push(child) },
    replaceChildren(...children: any[]) { this.children = children } })
  const requests: { url: string; resolve: (value: any) => void }[] = []
  const pushed: string[] = []
  const listeners: Record<string, () => any> = {}
  let location = new URL('http://fake/history?repo=%2Fsaved&status=completed')
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { createElement: element, getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)
    } }, URLSearchParams, AbortController, setTimeout, clearTimeout,
    window: { get location() { return location }, history: { pushState(_a: any, _b: any, url: string) {
      pushed.push(url); location = new URL(url, location)
    } }, addEventListener(name: string, fn: () => any) { listeners[name] = fn } },
    fetch: (url: string) => new Promise(resolve => requests.push({ url, resolve })),
  })
  const el = (id: string) => elements.get(id)
  const answer = async (ids: string[], next = 'next-page') => {
    requests.at(-1)!.resolve({ ok: true, json: async () => ids.map(id => ({ id, status: 'completed',
      prompt: '<script>evil()</script>' })), headers: { get: () => next } })
    await new Promise(resolve => setImmediate(resolve))
  }
  const ids = [' spaced task ', '任务 🧠', 'literal%2F/slash%?#&', '<img src=x onerror="evil()">',
    '%2e', '..safe', 'x'.repeat(200)]
  await answer(ids, 'older-anchor')
  el('older').onclick(); await answer(ids)
  const retained = el('rows').children
  for (const [i, id] of ids.entries()) {
    const row = retained[i]
    const path = '/tasks/' + encodeURIComponent(id)
    for (const [cell, suffix] of [[4, '/log/view'], [6, '/changes/view']] as const) {
      const link = row.children[cell].children[0]
      assert.equal(link.tag, 'a')
      assert.equal(link.href, path + suffix)
      assert.equal(new URL(link.href, 'http://fake').pathname, path + suffix)
      assert.equal(decodeURIComponent(new URL(link.href, 'http://fake').pathname.split('/')[2]), id)
    }
    assert.equal(row.children[6].children[0].textContent, 'Changes')
    assert.equal(row.children.at(-1).children[2].href, path)
    assert.equal(row.children.at(-1).children[0].textContent, id)
    assert.equal(row.children.at(-1).children[0].children.length, 0)
    assert.equal(row.children[3].textContent, '<script>evil()</script>')
    assert.equal(row.children[3].children.length, 0)
  }
  for (const id of ['.', '..', '...', '\ud800', '\udfff', '', '   ', 'x'.repeat(201)]) {
    location = new URL('http://fake/history?repo=%2Frequested&before=bad-anchor')
    listeners.popstate()
    const failedUrl = requests.at(-1)!.url
    await answer(['valid-first-row', id], 'wrong-next')
    assert.equal(el('rows').children, retained)
    assert.match(el('displayed').textContent, /Stale.*Repository: \/saved; Status: completed; Page 2.*older-anchor/)
    assert.match(el('message').textContent, /Invalid history response/)
    assert.equal(el('retry').hidden, false)
    assert.equal(pushed.length, 0)
    el('retry').onclick()
    assert.equal(requests.at(-1)!.url, failedUrl)
    await answer([id])
    el('refresh').onclick()
    const query = new URL(requests.at(-1)!.url, 'http://fake').searchParams
    assert.equal(query.get('before'), 'older-anchor')
    assert.equal(query.get('repo'), '/saved')
    assert.equal(query.get('status'), 'completed')
    await answer([id])
  }
  el('older').onclick()
  assert.equal(new URL(requests.at(-1)!.url, 'http://fake').searchParams.get('before'), 'next-page')
  await answer(['recovered'])
  assert.match(el('displayed').textContent, /Page 3.*next-page/)
  assert.equal(el('retry').hidden, true)
})
