import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('history rejects complete malformed pages and preserves navigation until recovery', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const { port } = server.address() as { port: number }
  const html = await (await fetch(`http://127.0.0.1:${port}/history`)).text()
  const elements = new Map<string, any>()
  const element = () => ({ value: '', textContent: '', disabled: false, hidden: false, children: [] as any[],
    appendChild(child: any) { this.children.push(child) },
    replaceChildren(...children: any[]) { this.children = children },
  })
  const requests: { url: string; resolve: (value: any) => void }[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)
    }, createElement: element }, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: (url: string) => new Promise(resolve => requests.push({ url, resolve })),
  })
  const el = (id: string) => elements.get(id)
  const valid = { id: 'task?&', status: 'completed', prompt: 'Saved 🧠 prompt' }
  const answer = async (tasks: unknown, next: string | null = 'older?&') => {
    requests.at(-1)!.resolve({ ok: true, json: async () => tasks, headers: { get: () => next } })
    await new Promise(resolve => setImmediate(resolve))
  }
  await answer([null])
  assert.equal(el('rows').children.length, 0)
  assert.match(el('message').textContent, /unavailable/i)
  assert.equal(el('retry').hidden, false)
  el('retry').onclick(); await answer([valid])
  el('older').onclick(); await answer([valid], 'oldest')
  const retained = el('rows').children[0]
  assert.match(el('displayed').textContent, /Repository: All repositories; Status: All statuses; Page 2.*older\?&/)
  const badRows: unknown[] = [null, 1, 'row', [], {}, { status: 'failed' },
    { ...valid, id: '' }, { ...valid, id: '   ' }, { ...valid, id: {} },
    { ...valid, id: '\ud800' }, { ...valid, status: 'unknown' }]
  for (const field of ['createdAt', 'startedAt', 'completedAt', 'repo', 'branch', 'prompt',
    'errorMessage', 'commitSha', 'provider', 'model']) {
    badRows.push({ ...valid, [field]: { unsafe: 'metadata' } })
    badRows.push({ ...valid, [field]: 42 })
  }
  for (const field of ['promptTruncated', 'autoCommit']) badRows.push({ ...valid, [field]: 'true' })
  const malformedPages = [null, {}, 1, ...badRows.map(row => [valid, row]), Array(26).fill(valid)]
  for (const page of malformedPages) {
    el('repo').value = '/unavailable'; el('repo').onchange()
    const failedUrl = requests.at(-1)!.url
    await answer(page, 'wrong-cursor')
    assert.equal(el('rows').children[0], retained)
    assert.equal(el('rows').children.length, 1)
    assert.match(el('message').textContent, /[Ss]tale/)
    assert.match(el('displayed').textContent, /Stale.*All repositories.*All statuses.*Page 2.*older\?&/)
    for (const control of ['older', 'newer', 'latest']) assert.equal(el(control).disabled, false)
    assert.equal(el('retry').hidden, false)
    el('retry').onclick()
    assert.equal(requests.at(-1)!.url, failedUrl)
    await answer(page)
    el('refresh').onclick()
    const query = new URL(requests.at(-1)!.url, 'http://fake').searchParams
    assert.equal(query.get('before'), 'older?&')
    assert.equal(query.has('repo'), false)
    await answer(page)
  }
  el('older').onclick()
  assert.equal(new URL(requests.at(-1)!.url, 'http://fake').searchParams.get('before'), 'oldest')
  await answer([{ ...valid, id: 'recovered', repo: null, branch: null, prompt: null,
    provider: null, model: null, autoCommit: null, promptTruncated: null }], null)
  assert.match(el('displayed').textContent, /Page 3.*oldest/)
  assert.equal(el('retry').hidden, true)
  assert.match(el('rows').children[0].children[4].children[0].href, /recovered/)
  el('latest').onclick(); await answer([], null)
  assert.equal(el('rows').children.length, 0)
  assert.equal(el('message').textContent, 'No tasks found.')
  assert.equal(el('retry').hidden, true)
})
