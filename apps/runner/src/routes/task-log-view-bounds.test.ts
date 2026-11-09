import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

// Execute the actual inline client without importing the database-backed router.
async function viewer() {
  const source = await readFile(new URL('./task-log-view.ts', import.meta.url), 'utf8')
  const script = source.match(/    <script>([\s\S]*?)<\/script>/)![1]
    .replace('${streamLiteral}', JSON.stringify('/tasks/test/stream'))
    .replace('${statusLiteral}', JSON.stringify('running'))
  const elements = new Map<string, any>()
  const listeners = new Map<string, (event: any) => void>()
  let closed = false
  function element() {
    return {
      hidden: true, value: '', textContent: '', scrollTop: 0, clientHeight: 100,
      children: [] as any[],
      // Deterministic wrapped text geometry, independent of browser layout.
      get scrollHeight(): number { return this.children.reduce((n, child) => n + child.textContent.length, 0) },
      appendChild(child: any) { this.children.push(child) },
      remove() {},
    }
  }
  runInNewContext(script, {
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      },
      createTextNode: (text: string) => ({ textContent: text }),
      createElement: element,
    },
    EventSource: class {
      addEventListener(name: string, fn: (event: any) => void) { listeners.set(name, fn) }
      close() { closed = true }
    },
    sessionStorage: { getItem: () => '' },
    fetch: async () => ({ ok: true, json: async () => ({ status: 'running' }) }),
  })
  await new Promise(resolve => setImmediate(resolve))
  return {
    source, elements, listeners, isClosed: () => closed,
    log: (text: string) => listeners.get('log')!({ data: JSON.stringify(text) }),
  }
}

test('many log frames retain bounded inert Unicode text and terminal controls', async () => {
  const v = await viewer()
  const log = v.elements.get('log')
  const limit = 128 * 1024
  let expected = ''
  for (let i = 0; i < 4000; i++) {
    const frame = '😀<img onerror=alert(1)>\n'.repeat(4)
    expected += frame
    v.log(frame)
    assert.equal(log.children.length, 1)
    assert.ok(log.children[0].textContent.length <= limit)
  }
  const retained = log.children[0].textContent
  assert.ok(expected.endsWith(retained))
  assert.equal(retained.isWellFormed(), true)
  assert.ok(retained.includes('<img onerror=alert(1)>'))
  assert.equal(v.elements.get('omitted').hidden, false)
  assert.match(v.source, /<p id="omitted"[^>]*hidden>/)
  assert.match(v.source, /href="\$\{rawHref\}">raw text/)
  assert.equal(log.scrollTop, log.scrollHeight)
  assert.equal(v.elements.get('cancel').hidden, false)
  assert.equal(typeof v.elements.get('cancel').onclick, 'function')
  v.listeners.get('complete')!({})
  assert.equal(v.elements.get('status').textContent, 'completed')
  assert.equal(v.elements.get('cancel').hidden, true)
  assert.equal(v.elements.get('retry').hidden, false)
  assert.equal(typeof v.elements.get('retry').onclick, 'function')
  assert.equal(v.isClosed(), true)
  assert.equal(v.elements.get('omitted').hidden, false)
})

test('oversized frames, split-frame surrogate pairs, and unpinned scrolling', async () => {
  const v = await viewer()
  const log = v.elements.get('log')
  const limit = 128 * 1024
  v.log('a'.repeat(limit))
  log.scrollTop = 1000
  v.log('b'.repeat(100))
  assert.equal(log.scrollTop, 900, 'removed prefix offsets the reading position')
  v.log('c'.repeat(limit * 2))
  assert.equal(log.scrollTop, 0, 'evicted reading position clamps to oldest retained text')
  assert.equal(log.children[0].textContent, 'c'.repeat(limit))
  v.log('\ud83d')
  v.log('\ude00' + 'x'.repeat(limit - 1))
  assert.equal(log.children[0].textContent, 'x'.repeat(limit - 1), 'cut skips the entire pair')
  assert.equal(log.children[0].textContent.isWellFormed(), true)
  v.listeners.get('error')!({ data: JSON.stringify('failure 😀') })
  assert.equal(v.elements.get('status').textContent, 'failed')
  assert.equal(v.elements.get('retry').hidden, false)
  assert.equal(v.isClosed(), true)
})
