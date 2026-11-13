import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import express from 'express'

// Render the real HTML template offline, without initializing SQLite or a runner.
async function fixture() {
  const source = await readFile(new URL('./task-log-view.ts', import.meta.url), 'utf8')
  const template = source.slice(source.indexOf('function escapeHtml'), source.indexOf('// GET /tasks/:id/log/view — a distinct'))
    .replace(/function escapeHtml\(value: string\): string/, 'function escapeHtml(value)')
    .replace('function missingViewHtml(id: string): string', 'function missingViewHtml(id)')
    .replace(/interface LaunchMeta \{[\s\S]*?\n\}/, '')
    .replace('function viewHtml(id: string, meta: LaunchMeta): string', 'function viewHtml(id, meta)')
  return runInNewContext(template + '\nviewHtml("offline", { status: "running" })', { TextDecoder }) as string
}

test('served transcript is a named keyboard region with a visible focus outline', async t => {
  const rendered = await fixture()
  const server = express().get('/tasks/offline/log/view', (_req, res) => res.type('html').send(rendered)).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const response = await fetch(`http://127.0.0.1:${address.port}/tasks/offline/log/view`)
  assert.equal(response.status, 200)
  const html = await response.text()
  const region = html.match(/<pre id="log"[^>]*>/)![0]
  assert.match(region, /role="region"/)
  assert.match(region, /aria-label="Task transcript"/)
  assert.match(region, /tabindex="0"/)
  assert.doesNotMatch(region, /aria-live|role="log"|contenteditable/)
  assert.match(html, /#log:focus-visible\s*\{[^}]*outline: 2px solid var\(--accent\);[^}]*outline-offset: -2px/)
  assert.match(html, /#log\s*\{[^}]*overflow: auto/)
  assert.doesNotMatch(html, /user-select:\s*none|onkeydown|onkeyup|preventDefault\(/)
})

test('streaming, trimming, replay and completion preserve keyboard focus and paused position', async () => {
  const html = await fixture()
  const listeners = new Map<string, (event: any) => void>()
  const elements = new Map<string, any>()
  const document = {
    activeElement: null as any,
    getElementById(id: string): any {
      if (!elements.has(id)) elements.set(id, {
        value: '', textContent: '', hidden: false, scrollTop: 0, clientHeight: 100,
        childNodes: [] as any[],
        get scrollHeight(): number { return this.childNodes.reduce((n: number, node: any) => n + node.textContent.length, 0) },
        appendChild(node: any) { this.childNodes.push(node) },
        remove() {},
        focus() { document.activeElement = this },
      })
      return elements.get(id)
    },
    createTextNode: (text: string) => ({ textContent: text }),
  }
  const log = document.getElementById('log')
  log.focus()
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
    document,
    EventSource: class {
      addEventListener(name: string, fn: (event: any) => void) { listeners.set(name, fn) }
      close() {}
    },
    sessionStorage: { getItem: () => '' },
    fetch: async () => ({ ok: true, json: async () => ({ status: 'running' }) }),
  })
  await new Promise(resolve => setImmediate(resolve))
  const emit = (name: string, text = '') => {
    listeners.get(name)!({ data: JSON.stringify(text) })
    assert.equal(document.activeElement, log)
  }
  emit('open')
  emit('log', 'x'.repeat(128 * 1024))
  log.scrollTop = 1000 // Native keyboard scrolling changes the same scroll position.
  emit('log', 'y'.repeat(100))
  assert.equal(log.scrollTop, 900)
  assert.equal(log.childNodes.length, 1)
  assert.equal(log.childNodes[0].textContent.length, 128 * 1024)
  // Updates also leave focus on other controls when the reader moves there.
  const token = document.getElementById('authToken')
  token.focus()
  listeners.get('log')!({ data: JSON.stringify('more') })
  assert.equal(document.activeElement, token)
  log.focus()
  emit('open')
  emit('log', 'fresh replay')
  emit('status', 'running')
  emit('complete')
})
