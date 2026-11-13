import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('history rows offer native transcript downloads for safe identities and every task status', async t => {
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
    requests.at(-1)!.resolve({ ok: true, json: async () => ids.map((id, index) => ({ id, status: ['queued', 'running', 'completed', 'failed'][index % 4],
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
    const logs = row.children[4]
    assert.equal(logs.children[0].textContent, 'View logs')
    const download = logs.children[2]
    assert.equal(download.tag, 'a')
    assert.equal(download.textContent, 'Download transcript')
    assert.equal(download.href, path + '/log?format=text&download=1')
    const url = new URL(download.href, 'http://fake')
    assert.equal(decodeURIComponent(url.pathname.split('/')[2]), id)
    assert.equal(url.search, '?format=text&download=1')
    assert.equal(download.onclick, undefined, 'browser handles the native link')
    assert.equal(download.tabIndex, undefined, 'link keeps native keyboard navigation')
    assert.equal(download.children.length, 0)
    assert.equal(row.children[6].children[0].textContent, 'Changes')
    assert.equal(row.children.at(-1).children[2].href, path)
    assert.equal(row.children.at(-1).children[0].textContent, id)
    assert.equal(row.children.at(-1).children[0].children.length, 0)
    assert.equal(row.children[3].textContent, '<script>evil()</script>')
    assert.equal(row.children[3].children.length, 0)
  }
  assert.equal(requests.length, 2, 'rendering rows never requests transcripts')
})
