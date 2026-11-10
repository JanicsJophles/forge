import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

async function viewer(response: unknown, status = 'failed') {
  const source = await readFile(new URL('./task-log-view.ts', import.meta.url), 'utf8')
  const script = source.match(/    <script>([\s\S]*?)<\/script>/)![1]
    .replace('${streamLiteral}', JSON.stringify('/tasks/test/stream'))
    .replace('${statusLiteral}', JSON.stringify(status))
  const elements = new Map<string, any>()
  const requests: { url: string; options: any }[] = []
  function element(): any {
    let text = ''
    return {
      value: '', hidden: true, disabled: false, childNodes: [] as any[],
      get textContent(): string { return text + this.childNodes.map((n: any) => n.textContent).join('') },
      set textContent(value: string) { text = value; this.childNodes = [] },
      appendChild(child: any) { this.childNodes.push(child) },
    }
  }
  runInNewContext(script, {
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      },
      createElement: element,
    },
    EventSource: class { addEventListener() {} close() {} },
    sessionStorage: { getItem: () => 'private-token' },
    fetch: async (url: string, options?: any) => {
      requests.push({ url, options })
      if (!options) return { ok: true, json: async () => ({ status }) }
      if (response instanceof Error) throw response
      return response
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  const el = (id: string) => elements.get(id)!
  await el('retry').onclick()
  assert.equal(requests.filter(r => r.options?.method === 'POST').length, 1)
  assert.equal(requests[1].url, '/tasks/test/retry')
  assert.equal(requests[1].options.headers.Authorization, 'Bearer private-token')
  assert.equal(el('status').textContent, status)
  assert.equal(el('retry').hidden, false)
  assert.equal(el('cancel').hidden, true)
  assert.equal(el('retry').disabled, false)
  assert.equal(el('cancel').disabled, false)
  assert.ok(!el('actionMessage').textContent.includes('private-token'))
  return { el, requests }
}

test('retry validates successful IDs and directs ambiguous responses to history', async () => {
  for (const body of [null, [], {}, { taskId: '' }, { taskId: '  ' }, { taskId: 42 },
    { taskId: {} }, { taskId: 'x'.repeat(201) }, { taskId: 'prefix-private-token' }]) {
    const h = await viewer({ ok: true, status: 201, json: async () => body })
    const message = h.el('actionMessage')
    assert.match(message.textContent, /task may have started.*before retrying/)
    assert.equal(message.childNodes.length, 1)
    assert.equal(message.childNodes[0].href, '/history')
    assert.equal(message.childNodes[0].textContent, 'Task history')
  }
})

test('non-JSON success warns about possible launch without exposing parse errors', async () => {
  const h = await viewer({ ok: true, status: 201, json: async () => { throw new Error('private-token <html>') } })
  assert.match(h.el('actionMessage').textContent, /task may have started/)
  assert.equal(h.el('actionMessage').childNodes[0].href, '/history')
})

test('valid hostile IDs are encoded as a whole path segment', async () => {
  for (const taskId of ['a/b? <x>"#%', 'x'.repeat(200)]) {
    const h = await viewer({ ok: true, status: 201, json: async () => ({ taskId }) }, 'completed')
    const link = h.el('actionMessage').childNodes[0]
    assert.equal(link.textContent, 'Open retried task')
    assert.equal(link.href, '/tasks/' + encodeURIComponent(taskId) + '/log/view')
  }
})

test('HTTP and network action errors are bounded, redacted, and rendered as text', async () => {
  for (const response of [
    { ok: false, status: 409, json: async () => ({ error: '<img> private-token ' + 'x'.repeat(2000) }) },
    new Error('<img> private-token ' + 'x'.repeat(2000)),
  ]) {
    const h = await viewer(response)
    const message = h.el('actionMessage')
    assert.ok(message.textContent.length <= 500)
    assert.match(message.textContent, /<img> \[redacted\]/)
    assert.equal(message.childNodes.length, 0)
  }
  const h = await viewer({ ok: false, status: 502, json: async () => { throw new Error('private-token') } })
  assert.match(h.el('actionMessage').textContent, /HTTP 502.*runner logs/)
})
