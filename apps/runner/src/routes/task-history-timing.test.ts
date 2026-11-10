import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('history renders UTC timing from list fields and refreshes active elapsed time', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const { port } = server.address() as { port: number }
  const html = await (await fetch(`http://127.0.0.1:${port}/history`)).text()
  assert.match(html, /<th>Run duration<\/th><th>Completed \(UTC\)<\/th>/)
  const elements = new Map<string, any>()
  const element = () => ({
    value: '', children: [] as any[], textContent: '', disabled: false,
    appendChild(child: any) { this.children.push(child) },
    replaceChildren(...children: any[]) { this.children = children },
  })
  const fixtures = [
    { status: 'completed', startedAt: '2026-11-10 01:00:00', completedAt: '2026-11-10T02:02:03Z' },
    { status: 'failed', startedAt: '2026-11-10T03:00:00+02:00', completedAt: '2026-11-10 01:00:02.500', errorMessage: '<timeout>' },
    { status: 'running', startedAt: '2026-11-10 01:00:00' },
    { status: 'queued', startedAt: '2026-11-10 01:00:00' },
    { status: 'completed', completedAt: '2026-11-10T01:00:00Z' },
    { status: 'failed', startedAt: 'bad', completedAt: 'bad' },
    { status: 'completed', startedAt: '2026-11-10T01:00:00Z', completedAt: '2026-11-10 00:59:59' },
    { status: 'running', startedAt: '2026-11-10T02:00:00Z' },
    { status: 'running', startedAt: '2026-02-30 01:00:00' },
    { status: 'completed', startedAt: '2026-11-10T01:00:00', completedAt: '2026-11-10T01:00:02Z' },
    { status: 'failed', startedAt: '2026-11-10 01:00:00', completedAt: null },
    { status: 'failed', startedAt: '2026-11-10 01:00:00', completedAt: '2026-02-30T01:00:00Z' },
  ]
  let now = Date.parse('2026-11-10T01:01:05Z')
  class ReadDate extends Date { static now() { return now } }
  const requests: string[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      },
      createElement: element,
    },
    Date: ReadDate, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (url: string) => {
      requests.push(url)
      return { ok: true, json: async () => fixtures.map((task, id) => ({ id: String(id), ...task })),
        headers: { get: () => null } }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  const cells = (index: number) => elements.get('rows').children[index].children
  assert.deepEqual(fixtures.map((_, i) => cells(i)[7].textContent), [
    '1h 2m 3s', '2s', 'Running · 1m 5s elapsed', 'Unknown', 'Unknown', 'Unknown',
    '0s', 'Running · 0s elapsed', 'Running · unknown elapsed', 'Unknown', 'Unknown', 'Unknown',
  ])
  assert.equal(cells(0)[8].textContent, '2026-11-10 02:02:03 UTC')
  assert.equal(cells(1)[8].textContent, '2026-11-10 01:00:02.500 UTC')
  assert.equal(cells(1)[0].children[0].textContent, '<timeout>')
  for (const i of [2, 3, 5, 7, 8, 10, 11]) assert.equal(cells(i)[8].textContent, 'Unknown')
  assert.equal(requests.length, 1)
  now += 60000
  await elements.get('refresh').onclick()
  assert.equal(cells(2)[7].textContent, 'Running · 2m 5s elapsed')
  assert.equal(requests.length, 2)
  assert.ok(requests.every(url => url.startsWith('/tasks?')))
})
