import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

async function viewer() {
  const source = await readFile(new URL('./task-log-view.ts', import.meta.url), 'utf8')
  const script = source.match(/    <script>([\s\S]*?)<\/script>/)![1]
    .replace('${streamLiteral}', JSON.stringify('/tasks/test/stream'))
    .replace('${statusLiteral}', JSON.stringify('running'))
  const elements = new Map<string, any>()
  const listeners = new Map<string, (event: any) => void>()
  let closed = false
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
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      },
      createTextNode: (text: string) => element(text), createElement: () => element(),
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
    elements, source, closed: () => closed,
    event: (name: string, text?: string) => listeners.get(name)!(text === undefined ? {} : { data: JSON.stringify(text) }),
  }
}

test('no-newline output stays exact while hostile multiline diagnostic is separate', async () => {
  const v = await viewer()
  v.event('open')
  v.event('log', 'final output without newline')
  const reason = '<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n日本語 😀'
  v.event('error', reason)
  assert.equal(v.elements.get('log').textContent, 'final output without newline')
  assert.equal(v.elements.get('failure').hidden, false)
  assert.equal(v.elements.get('failureReason').textContent, reason)
  assert.equal(v.elements.get('failureReason').childNodes.length, 0)
  assert.equal(v.closed(), true)
  v.event('complete')
  v.event('status', 'completed')
  v.event('log', 'late output')
  v.event('error', 'late failure')
  assert.equal(v.elements.get('status').textContent, 'failed')
  assert.equal(v.elements.get('failureReason').textContent, reason)
  assert.equal(v.elements.get('log').textContent, 'final output without newline')
  assert.match(v.source, /<section id="failure" aria-labelledby="failureLabel" hidden>/)
  assert.match(v.source, /Full task detail JSON — complete saved failure reason/)
  assert.match(v.source, /<\/pre>\s*<section id="failure"/)
  assert.match(v.source, /failure pre.*white-space: pre-wrap; overflow-wrap: anywhere/)
  assert.doesNotMatch(v.source, /\.innerHTML/)
})

test('capped failure preview survives bounded transcript eviction and links to same task detail', async () => {
  const v = await viewer()
  const output = 'x'.repeat(140000)
  const reason = 'failure\n'.repeat(1100) + '[truncated]'
  v.event('log', output)
  const transcript = v.elements.get('log').textContent
  v.event('error', reason)
  assert.equal(v.elements.get('log').textContent, transcript)
  assert.equal(transcript.length, 128 * 1024)
  assert.equal(v.elements.get('failureReason').textContent, reason)
  assert.match(v.source, /href="\$\{escapeHtml\(`\/tasks\/\$\{encodedId\}\?view=detail`\)\}">Full task detail JSON — complete saved failure reason/)
  assert.match(v.source, /log\?format=text&download=1/)
})

test('transport drops and completed streams never display task failure diagnostics', async () => {
  const v = await viewer()
  v.event('open')
  v.event('log', 'old output')
  v.event('error')
  assert.equal(v.elements.get('status').textContent, 'reconnecting…')
  assert.equal(v.elements.get('failure'), undefined)
  assert.equal(v.closed(), false)
  v.event('open')
  v.event('log', 'replayed output')
  v.event('complete')
  v.event('error', 'late failure')
  v.event('error')
  assert.equal(v.elements.get('status').textContent, 'completed')
  assert.equal(v.elements.get('failure'), undefined)
  assert.equal(v.elements.get('log').textContent, 'replayed output')
  assert.equal(v.closed(), true)
})
