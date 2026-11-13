import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('history retains full inert task identities through pagination, refresh and filtering', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const { port } = server.address() as { port: number }
  const html = await (await fetch(`http://127.0.0.1:${port}/history`)).text()
  assert.match(html, /<th>Task ID<\/th>/)
  assert.doesNotMatch(html, /innerHTML/)
  const elements = new Map<string, any>()
  const element = (tag = '') => ({ tag, textContent: '', value: '', disabled: false,
    children: [] as any[], appendChild(child: any) { this.children.push(child) },
    replaceChildren(...children: any[]) { this.children = children },
  })
  const requests: { url: string; resolve: (value: any) => void }[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { createElement: element, getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)
    } }, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: (url: string) => new Promise(resolve => requests.push({ url, resolve })),
  })
  const el = (id: string) => elements.get(id)
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const task = (id?: string) => ({ id, createdAt: '2026-11-10 09:00:00',
    status: 'completed', repo: '/checkout', prompt: 'Identical retry prompt' })
  const answer = async (tasks: any[], next: string | null = null) => {
    requests.at(-1)!.resolve({ ok: true, json: async () => tasks, headers: { get: () => next } })
    await tick()
  }
  const check = (ids: (string | undefined)[]) => {
    assert.equal(el('rows').children.length, ids.length)
    el('rows').children.forEach((row: any, index: number) => {
      const identity = row.children.at(-1)
      assert.equal(identity.children[0].tag, 'code')
      assert.equal(identity.children[0].textContent, ids[index] || 'Unavailable')
      assert.equal(identity.children[0].children.length, 0)
      if (ids[index]) {
        assert.equal(identity.children[2].href, '/tasks/' + encodeURIComponent(ids[index]!))
        assert.equal(identity.children[2].textContent, 'Task JSON')
      } else {
        assert.equal(identity.children.length, 1)
        assert.equal(row.children[4].children.length, 0)
        assert.equal(row.children[6].children.length, 0)
      }
    })
  }
  const ids = ['full-task-id-retry-0001', 'full-task-id-retry-0002']
  await answer(ids.map(task), 'older-cursor')
  check(ids)
  el('older').onclick()
  assert.equal(new URL(requests.at(-1)!.url, 'http://fake').searchParams.get('before'), 'older-cursor')
  const hostile = '<img src=x onerror="evil()">/../../?#&'
  await answer([task(hostile), task(), task('')])
  check(ids)
  assert.match(el('message').textContent, /Invalid history response/)
  assert.match(el('displayed').textContent, /Stale.*Page 1/)
  assert.equal(el('older').disabled, false)
  el('retry').onclick()
  assert.equal(new URL(requests.at(-1)!.url, 'http://fake').searchParams.get('before'), 'older-cursor')
  await answer([task(hostile)])
  check([hostile])
  assert.match(el('displayed').textContent, /Page 2.*older-cursor/)
  el('refresh').onclick()
  await answer([task(hostile)])
  check([hostile])
  el('newer').onclick()
  await answer(ids.map(task))
  check(ids)
  el('repo').value = '/filtered'
  el('repo').onchange()
  assert.equal(new URL(requests.at(-1)!.url, 'http://fake').searchParams.get('repo'), '/filtered')
  await answer([task(ids[1])])
  check([ids[1]])
})
