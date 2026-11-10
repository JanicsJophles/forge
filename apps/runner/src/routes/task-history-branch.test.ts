import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'
import { taskHistoryViewRouter } from './task-history-view.js'

test('history shows recorded branches as inert repository metadata without extra reads', async t => {
  const server = express().use(taskHistoryViewRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const { port } = server.address() as { port: number }
  const html = await (await fetch(`http://127.0.0.1:${port}/history`)).text()
  const elements = new Map<string, any>()
  const element = () => ({ value: '', textContent: '', disabled: false, hidden: false, children: [] as any[],
    appendChild(child: any) { this.children.push(child) },
    replaceChildren(...children: any[]) { this.children = children },
    set innerHTML(_value: string) { assert.fail('metadata must use textContent') },
  })
  const branches = ['fleet/next', 'feature/other', undefined, null, '', '   ', 'HEAD', '<img src=x onerror=alert(1)>']
  const repo = '/checkout/<script>alert(1)</script>'
  const requests: string[] = []
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document: { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)
    }, createElement: element }, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async (url: string) => {
      requests.push(url)
      return { ok: true, json: async () => branches.map((branch, index) => ({
        id: 'task-' + index, repo, branch, status: 'completed', prompt: 'fixture',
      })), headers: { get: () => null } }
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  const rows = elements.get('rows').children
  assert.equal(rows.length, branches.length)
  for (const [index, row] of rows.entries()) {
    const repository = row.children[2]
    assert.equal(repository.textContent, repo)
    assert.equal(repository.children.length, 1)
    assert.equal(repository.children[0].textContent, 'Branch: ' + (
      typeof branches[index] === 'string' && branches[index]!.trim() ? branches[index] : 'unspecified'))
    assert.equal(repository.children[0].children.length, 0)
    assert.equal(row.children[3].textContent, 'fixture')
  }
  assert.equal(requests.length, 1)
  assert.match(requests[0], /^\/tasks\?/)
})
