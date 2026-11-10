import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

async function viewer(throws = 0) {
  const source = await readFile(new URL('./task-log-view.ts', import.meta.url), 'utf8')
  const script = source.match(/    <script>([\s\S]*?)<\/script>/)![1]
    .replace('${streamLiteral}', JSON.stringify('/tasks/test/stream'))
    .replace('${statusLiteral}', JSON.stringify('running'))
  const elements = new Map<string, any>()
  const sources: any[] = []
  let attempts = 0
  function element(text = ''): any {
    let value = text
    return {
      hidden: true, value: '', scrollTop: 0, clientHeight: 100, childNodes: [] as any[],
      get textContent(): string { return value + this.childNodes.map((n: any) => n.textContent).join('') },
      set textContent(text: string) { value = text; this.childNodes = [] },
      get scrollHeight(): number { return this.textContent.length },
      appendChild(child: any) { this.childNodes.push(child); child.parent = this },
      remove() {
        if (this.parent) this.parent.childNodes = this.parent.childNodes.filter((n: any) => n !== this)
      },
    }
  }
  runInNewContext(script, {
    AbortController, setTimeout, clearTimeout,
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      },
      createTextNode: (text: string) => element(text), createElement: () => element(),
    },
    EventSource: class {
      listeners = new Map<string, (event: any) => void>()
      closed = false
      constructor() {
        attempts++
        if (throws-- > 0) throw new Error('unavailable')
        sources.push(this)
      }
      addEventListener(name: string, fn: (event: any) => void) { this.listeners.set(name, fn) }
      close() { this.closed = true }
      event(name: string, text?: string) {
        this.listeners.get(name)!(text === undefined ? {} : { data: JSON.stringify(text) })
      }
    },
    sessionStorage: { getItem: () => '' },
    fetch: async () => ({ ok: true, json: async () => ({ status: 'running' }) }),
  })
  await new Promise(resolve => setImmediate(resolve))
  return {
    elements, sources, attempts: () => attempts,
    reconnect: () => elements.get('reconnect').onclick(),
  }
}


test('constructor failures keep recovery and task controls available', async () => {
  const v = await viewer(2)
  const control = v.elements.get('reconnect')
  assert.equal(control.hidden, false)
  assert.equal(v.elements.get('cancel').hidden, false)
  v.reconnect()
  assert.equal(v.attempts(), 2)
  assert.equal(control.hidden, false)
  v.reconnect()
  assert.equal(v.attempts(), 3)
  assert.equal(v.sources.length, 1)
  v.sources[0].event('open')
  assert.equal(control.hidden, true)
})

for (const terminal of ['complete', 'error']) {
  test('manual replacements ignore stale events and stop after ' + terminal, async () => {
    const v = await viewer()
    const log = v.elements.get('log')
    let current = v.sources[0]
    current.event('open')
    current.event('log', 'original')
    for (let i = 0; i < 4; i++) {
      current.event('error')
      assert.equal(v.elements.get('reconnect').hidden, false)
      const old = current
      const count = v.sources.length
      v.reconnect()
      assert.equal(old.closed, true)
      assert.equal(v.sources.length, count + 1)
      current = v.sources.at(-1)
      for (const name of ['open', 'log', 'status', 'complete', 'error']) old.event(name, 'stale')
      assert.notEqual(v.elements.get('status').textContent, 'stale')
      assert.equal(log.textContent.includes('stale'), false)
      current.event('open')
      assert.equal(log.textContent, '')
      assert.equal(v.elements.get('replayNotice').hidden, false)
      current.event('log', 'x'.repeat(140000))
      assert.equal(log.textContent.length, 128 * 1024)
      assert.equal(log.childNodes.length, 1)
      assert.equal(v.elements.get('omitted').hidden, false)
    }
    current.event(terminal, terminal === 'error' ? 'failed' : undefined)
    const text = log.textContent
    const count = v.sources.length
    assert.equal(current.closed, true)
    assert.equal(v.elements.get('reconnect').hidden, true)
    assert.equal(v.elements.get('retry').hidden, false)
    assert.equal(v.elements.get('cancel').hidden, true)
    v.reconnect()
    current.event('open')
    current.event('log', 'late')
    current.event('status', 'running')
    current.event('error')
    assert.equal(v.sources.length, count)
    assert.equal(log.textContent, text)
    assert.equal(v.elements.get('retry').hidden, false)
  })
}
