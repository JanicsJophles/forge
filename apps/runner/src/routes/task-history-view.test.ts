import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('history shell pages opaque same-second cursors, resets filters and fences failures', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve())
    server.closeAllConnections()
  }))
  const { port } = server.address() as { port: number }
  const response = await fetch(`http://127.0.0.1:${port}/history`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type')!, /text\/html/)
  const html = await response.text()
  assert.match(html, /href="\/dashboard"/)
  assert.doesNotMatch(html, /innerHTML/)
  const elements = new Map<string, any>()
  function element() {
    return { value: '', textContent: '', disabled: false, hidden: false, children: [] as any[],
      appendChild(child: any) { this.children.push(child) },
      replaceChildren(...children: any[]) { this.children = children },
    }
  }
  const requests: { url: string; resolve: (value: any) => void; reject: (reason: Error) => void }[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)
    }, createElement: element },
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: (url: string) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
  })
  const el = (id: string) => elements.get(id)
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const task = (id: string) => ({ id, status: 'failed', createdAt: '2026-11-09 12:00:00',
    repo: '<img src=x>', prompt: '<script>evil</script>' + 'x'.repeat(300), promptTruncated: true })
  const answer = (index: number, tasks: any[], next: string | null = null) => requests[index].resolve({
    ok: true, json: async () => tasks, headers: { get: (name: string) => {
      assert.equal(name, 'X-Next-Before'); return next
    } },
  })
  assert.match(el('message').textContent, /Loading/)
  assert.equal(el('newer').disabled, true)
  assert.equal(el('latest').disabled, true)
  assert.equal(new URL(requests[0].url, 'http://fake').searchParams.get('limit'), '25')
  answer(0, [task('same-second-new')], 'same-second-old?&')
  await tick()
  assert.equal(el('rows').children[0].children[2].textContent, '<img src=x>')
  assert.match(el('rows').children[0].children[3].textContent, /… \[truncated\]$/)
  assert.equal(el('rows').children[0].children[4].children[0].href, '/tasks/same-second-new/log/view')
  el('older').onclick()
  assert.equal(new URL(requests[1].url, 'http://fake').searchParams.get('before'), 'same-second-old?&')
  answer(1, [task('same-second-old?&')])
  await tick()
  assert.equal(el('older').disabled, true)
  assert.match(el('rows').children[0].children[4].children[0].href, /same-second-old%3F%26/)

  el('repo').value = '/repo?a&b'
  el('repo').onchange()
  el('status').value = 'failed'
  el('status').onchange()
  const query = new URL(requests[3].url, 'http://fake').searchParams
  assert.equal(query.get('repo'), '/repo?a&b')
  assert.equal(query.get('status'), 'failed')
  assert.equal(query.has('before'), false)
  answer(3, [])
  await tick()
  answer(2, [task('stale')], 'stale-next')
  await tick()
  assert.equal(el('rows').children.length, 0)
  assert.equal(el('message').textContent, 'No tasks found.')
  assert.equal(el('older').disabled, true)

  el('repo').onchange()
  el('status').onchange()
  requests[4].reject(new Error('stale network failure'))
  await tick()
  assert.match(el('message').textContent, /Loading/)
  requests[5].resolve({ ok: false, status: 503 })
  await tick()
  assert.match(el('message').textContent, /^Request failed: HTTP 503 Requested Repository:/)
  assert.equal(el('retry').hidden, false)
  el('retry').onclick()
  requests[6].reject(new Error('offline'))
  await tick()
  assert.match(el('message').textContent, /^Request failed: offline Requested Repository:/)
  el('retry').onclick()
  answer(7, [task('recovered')], 'retry-anchor')
  await tick()
  el('older').onclick()
  requests[8].resolve({ ok: false, status: 404 })
  await tick()
  el('retry').onclick()
  assert.equal(new URL(requests[9].url, 'http://fake').searchParams.get('before'), 'retry-anchor')
  answer(9, [])
  await tick()
  assert.equal(el('retry').hidden, true)

  // Start a fresh filtered history and traverse three pages in both directions.
  el('filters').onsubmit({ preventDefault() {} })
  answer(10, [task('page-one')], 'cursor-two')
  await tick()
  const pageId = () => el('rows').children[0].children[4].children[0].href
  const navigate = (control: string, before: string | null) => {
    const index = requests.length
    el(control).onclick()
    const params = new URL(requests[index].url, 'http://fake').searchParams
    assert.equal(params.get('before'), before)
    assert.equal(params.get('repo'), '/repo?a&b')
    assert.equal(params.get('status'), 'failed')
    for (const id of ['older', 'newer', 'latest']) assert.equal(el(id).disabled, true)
    return index
  }
  let index = navigate('older', 'cursor-two')
  assert.match(pageId(), /page-one/)
  answer(index, [task('page-two')], 'cursor-three')
  await tick()
  assert.equal(el('newer').disabled, false)
  assert.equal(el('latest').disabled, false)
  index = navigate('older', 'cursor-three')
  answer(index, [task('page-three')])
  await tick()
  assert.equal(el('older').disabled, true)

  // A failed return must preserve page three and its navigation depth.
  index = navigate('newer', 'cursor-two')
  requests[index].reject(new Error('offline'))
  await tick()
  assert.match(pageId(), /page-three/)
  assert.equal(el('newer').disabled, false)
  assert.equal(el('older').disabled, true)
  el('retry').onclick()
  assert.equal(new URL(requests[index + 1].url, 'http://fake').searchParams.get('before'), 'cursor-two')
  answer(index + 1, [task('page-two')], 'cursor-three')
  await tick()
  index = navigate('newer', null)
  answer(index, [task('page-one')], 'cursor-two')
  await tick()
  assert.equal(el('newer').disabled, true)
  assert.equal(el('latest').disabled, true)
  index = navigate('older', 'cursor-two')
  answer(index, [task('page-two')], 'cursor-three')
  await tick()
  index = navigate('older', 'cursor-three')
  answer(index, [task('page-three')])
  await tick()
  index = navigate('latest', null)
  requests[index].resolve({ ok: false, status: 503 })
  await tick()
  assert.match(pageId(), /page-three/)
  assert.equal(el('latest').disabled, false)
  index = navigate('latest', null)
  answer(index, [task('latest')], 'cursor-two')
  await tick()
  assert.match(pageId(), /latest/)
  assert.equal(el('newer').disabled, true)
  assert.equal(el('latest').disabled, true)

  // Reset during an older request; neither stale success nor reset failure loses rows.
  index = navigate('older', 'cursor-two')
  el('repo').value = '/different'
  el('repo').onchange()
  answer(index, [task('superseded')], 'stale-cursor')
  await tick()
  assert.match(pageId(), /latest/)
  requests[index + 1].reject(new Error('filter request failed'))
  await tick()
  assert.match(pageId(), /latest/)
  assert.equal(el('older').disabled, false)
  for (const id of ['newer', 'latest']) assert.equal(el(id).disabled, true)
  el('retry').onclick()
  const resetQuery = new URL(requests[index + 2].url, 'http://fake').searchParams
  assert.equal(resetQuery.get('repo'), '/different')
  assert.equal(resetQuery.has('before'), false)
  answer(index + 2, [task('filtered')], 'filtered-cursor')
  await tick()
  assert.match(pageId(), /filtered/)
  assert.equal(el('older').disabled, false)
  assert.equal(el('newer').disabled, true)
  assert.equal(el('latest').disabled, true)
})
