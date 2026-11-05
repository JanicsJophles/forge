import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import type { Request, Response } from 'express'
import { dashboardRouter } from './dashboard.js'

// Capture the actual route response without opening a socket or reading source text.
function servedFormatter() {
  let html = ''
  dashboardRouter.handle(
    { method: 'GET', url: '/dashboard' } as Request,
    { setHeader() {}, send(body: string) { html = body } } as unknown as Response,
    (error?: unknown) => { if (error) throw error },
  )
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]
  const formatter = script.match(/function relTime\(iso\) \{[\s\S]*?\n    \}/)![0]
  const now = Date.parse('2026-11-05T12:00:00Z')
  class FixedDate extends Date {
    static now() { return now }
  }
  const context = vm.createContext({ Date: FixedDate })
  vm.runInContext(formatter, context)
  return (value: unknown) => {
    context.input = value
    return vm.runInContext('relTime(input)', context)
  }
}

test('served formatter treats SQLite UTC, ISO Z and explicit offsets as equivalent instants', () => {
  const relative = servedFormatter()
  for (const timestamp of [
    '2026-11-05 11:59:30', '2026-11-05T11:59:30Z',
    '2026-11-05T13:59:30+02:00', '2026-11-05T06:29:30-05:30',
    '2026-11-05T13:59:30+0200', '2026-11-05T11:59:30',
    ' 2026-11-05 11:59:30.000 ',
  ]) assert.equal(relative(timestamp), '30s ago', timestamp)
})

test('served formatter displays seconds, minutes, hours and days at their boundaries', () => {
  const relative = servedFormatter()
  for (const [seconds, expected] of [
    [0, '0s ago'], [59, '59s ago'], [60, '1m ago'], [3599, '59m ago'],
    [3600, '1h ago'], [86399, '23h ago'], [86400, '1d ago'], [259200, '3d ago'],
  ] as const) {
    const timestamp = new Date(Date.parse('2026-11-05T12:00:00Z') - seconds * 1000).toISOString()
    assert.equal(relative(timestamp), expected)
  }
})

test('served formatter uses a neutral placeholder for missing or malformed input and clamps future ages', () => {
  const relative = servedFormatter()
  for (const value of [undefined, null, '', ' ', 'invalid', '2026-99-99 12:00:00',
    '2026-11-05T11:59:30ZZ', 123, {}, []]) {
    assert.equal(relative(value), '—')
  }
  assert.equal(relative('2026-11-05T12:00:01Z'), '0s ago')
  assert.equal(relative('2027-11-05 12:00:00'), '0s ago')
})
