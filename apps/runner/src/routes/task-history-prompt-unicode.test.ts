import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('history clips prompts at 240 code points with explicit omission and inert text', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const { port } = server.address() as { port: number }
  const html = await (await fetch(`http://127.0.0.1:${port}/history`)).text()
  const omitted = '… [truncated]'
  const hostile = '<img src=x onerror=evil()></td><script>evil()</script>'
  const fixtures = [
    { prompt: 'a'.repeat(239) + '😀tail', expected: 'a'.repeat(239) + '😀' + omitted },
    { prompt: '😀'.repeat(241), expected: '😀'.repeat(240) + omitted },
    { prompt: 'a'.repeat(241), expected: 'a'.repeat(240) + omitted },
    { prompt: 'ordinary ASCII', expected: 'ordinary ASCII' },
    { prompt: 'a'.repeat(240), expected: 'a'.repeat(240) },
    { prompt: 'a'.repeat(239) + '😀', expected: 'a'.repeat(239) + '😀' },
    { prompt: 'short 😀', promptTruncated: true, expected: 'short 😀' + omitted },
    { prompt: '', expected: '' },
    { prompt: '', promptTruncated: true, expected: omitted },
    { prompt: hostile, expected: hostile },
    { prompt: hostile + '😀'.repeat(240), expected: hostile + '😀'.repeat(240 - hostile.length) + omitted },
    { prompt: 'a'.repeat(241), promptTruncated: true, expected: 'a'.repeat(240) + omitted },
  ]
  const elements = new Map<string, any>()
  const element = () => ({ value: '', textContent: '', disabled: false, hidden: false, children: [] as any[],
    appendChild(child: any) { this.children.push(child) },
    replaceChildren(...children: any[]) { this.children = children },
    set innerHTML(_value: string) { assert.fail('prompt must use textContent') },
  })
  const requests: string[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)
    }, createElement: element }, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (url: string) => {
      requests.push(url)
      return { ok: true, json: async () => fixtures.map((fixture, index) => ({
        id: 'task-' + index, repo: '/offline', status: 'completed', ...fixture,
      })), headers: { get: () => null } }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  const rows = elements.get('rows').children
  assert.equal(rows.length, fixtures.length)
  for (const [index, row] of rows.entries()) {
    const prompt = row.children[3]
    assert.equal(prompt.textContent, fixtures[index].expected, `fixture ${index}`)
    assert.equal(prompt.children.length, 0)
  }
  assert.deepEqual(requests, ['/tasks?limit=25'])
})
