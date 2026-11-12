import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const flush = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: (value: any) => void
  const promise = new Promise<any>(r => { resolve = r })
  return { promise, resolve }
}

async function viewer(t: any, retry: boolean, stage: string, taskId: unknown = 'new-run') {
  const source = await readFile(new URL('./task-log-view.ts', import.meta.url), 'utf8')
  const script = source.match(/    <script>([\s\S]*?)<\/script>/)![1]
    .replace('${streamLiteral}', JSON.stringify('/tasks/test/stream'))
    .replace('${statusLiteral}', JSON.stringify(retry ? 'failed' : 'running'))
  const elements = new Map<string, any>()
  const listeners = new Map<string, (e: any) => void>()
  const requests: any[] = []
  const late = deferred()
  let hang = true
  function element(): any {
    let text = ''
    return {
      value: '', hidden: true, disabled: false, childNodes: [] as any[],
      get textContent(): string { return text + this.childNodes.map((n: any) => n.textContent).join('') },
      set textContent(value: string) { text = value; this.childNodes = [] },
      appendChild(child: any) { this.childNodes.push(child) }, remove() {},
    }
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  runInNewContext(script, {
    AbortController, setTimeout, clearTimeout,
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element())
        return elements.get(id)
      },
      createElement: element, createTextNode: element,
    },
    sessionStorage: { getItem: () => 'private-token' },
    EventSource: class {
      addEventListener(name: string, fn: (e: any) => void) { listeners.set(name, fn) }
      close() {}
    },
    fetch: (url: string, options?: any) => {
      requests.push({ url, options })
      const mutation = options?.method
      if (hang && ((mutation && stage === 'fetch') || (options?.signal && !mutation && stage === 'status-fetch'))) return late.promise
      return Promise.resolve({ ok: true, status: 200, json: () => {
        if (hang && mutation && stage.startsWith('status-')) {
          return new Promise(resolve => setTimeout(() => resolve({}), 10000))
        }
        if (hang && ((mutation && stage === 'json') || (options?.signal && !mutation && stage === 'status-json'))) return late.promise
        return Promise.resolve(mutation ? { taskId } : { status: retry ? 'failed' : 'running' })
      } })
    },
  })
  await flush()
  return {
    el: (id: string) => elements.get(id)!, requests, late,
    event: (name: string, data?: string) => listeners.get(name)!(data ? { data: JSON.stringify(data) } : {}),
    resume: () => { hang = false },
  }
}

for (const retry of [false, true]) {
  for (const stage of retry ? ['fetch', 'json'] : ['fetch', 'json', 'status-fetch', 'status-json']) {
    test(`${retry ? 'retry' : 'cancel'} releases controls after hung ${stage} and ignores late completion`, async t => {
      const h = await viewer(t, retry, stage)
      const action = h.el(retry ? 'retry' : 'cancel').onclick()
      await flush()
      assert.equal(h.el('retry').disabled, true)
      // Spend most of the single deadline before SSE delivers a terminal event.
      t.mock.timers.tick(14999)
      await flush()
      assert.equal(h.el('cancel').disabled, true)
      h.event(retry ? 'complete' : 'error', retry ? undefined : 'task failed')
      assert.equal(h.el('retry').hidden, false)
      assert.equal(h.el('cancel').hidden, true)
      t.mock.timers.tick(1)
      await action
      assert.equal(h.el('retry').disabled, false)
      assert.equal(h.el('cancel').disabled, false)
      assert.match(h.el('actionMessage').textContent, /may have reached the runner.*status.*history.*before trying again/)
      assert.equal(h.el('actionMessage').childNodes[0].href, '/history')
      assert.equal(h.requests.filter(r => r.options?.method).length, 1, 'no automatic resend')
      assert.ok(h.requests.find(r => r.options?.method).options.signal.aborted)
      // A newer action must retain its link even when old transport ignores abort.
      h.resume()
      await h.el('retry').onclick()
      const message = h.el('actionMessage').textContent
      assert.equal(h.el('actionMessage').childNodes[0].href, '/tasks/new-run/log/view')
      h.late.resolve(stage.endsWith('fetch') ? {
        ok: true, json: async () => ({ taskId: 'stale', status: 'running' }),
      } : { taskId: 'stale', status: 'running' })
      await flush()
      assert.equal(h.el('actionMessage').textContent, message)
      assert.equal(h.el('actionMessage').childNodes.length, 1)
      assert.equal(h.el('status').textContent, retry ? 'completed' : 'failed')
      assert.equal(h.el('cancel').hidden, true)
    })
  }
}

test('deadline clears on successful cancel', async t => {
  const h = await viewer(t, false, 'none')
  await h.el('cancel').onclick()
  assert.equal(h.el('cancel').disabled, false)
  const message = h.el('actionMessage').textContent
  t.mock.timers.tick(15000)
  await flush()
  assert.equal(h.el('actionMessage').textContent, message)
})

test('ambiguous retry IDs link history without resending or leaking the token', async t => {
  for (const taskId of ['.', '..', '...', '\ud800', '\udfff', 'prefix\ud800suffix', 'private-token', '', null, 42]) {
    const h = await viewer(t, true, 'none', taskId)
    await h.el('retry').onclick()
    assert.equal(h.el('retry').disabled, false)
    assert.match(h.el('actionMessage').textContent, /task may have started/)
    assert.doesNotMatch(h.el('actionMessage').textContent, /private-token/)
    assert.equal(h.el('actionMessage').childNodes.length, 1)
    assert.equal(h.el('actionMessage').childNodes[0].href, '/history')
    assert.equal(h.requests.filter(r => r.options?.method).length, 1)
    t.mock.timers.reset()
  }
})

test('retry accepts encodable Unicode pairs and dotted task IDs', async t => {
  for (const taskId of ['run-😀', '.run', 'run.1', 'run..']) {
    const h = await viewer(t, true, 'none', taskId)
    await h.el('retry').onclick()
    assert.equal(h.el('actionMessage').childNodes[0].href,
      '/tasks/' + encodeURIComponent(taskId) + '/log/view')
    t.mock.timers.reset()
  }
})

test('action errors remain bounded and token redacted', async t => {
  const h = await viewer(t, true, 'fetch')
  const pending = h.el('retry').onclick()
  h.late.resolve({ ok: false, status: 409, json: async () => ({
    error: 'private-token <script>' + 'x'.repeat(1000),
  }) })
  await pending
  assert.match(h.el('actionMessage').textContent, /HTTP 409: \[redacted\]/)
  assert.ok(h.el('actionMessage').textContent.length < 550)
  assert.equal(h.el('retry').disabled, false)
})
