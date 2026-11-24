import { test } from 'node:test'
import assert from 'node:assert/strict'
import { continuedPrompt, usageLimitLine, validFallbacks } from '../src/agent/failover.js'

test('a Claude run that exits on its usage limit is a limit stop', () => {
  const log = '[forge] git pull completed\n[forge] starting claude agent in /repo\nClaude AI usage limit reached|1764000000\n'
  assert.equal(usageLimitLine(log, 1), 'Claude AI usage limit reached|1764000000')
  assert.equal(usageLimitLine('[forge] starting claude agent\n5-hour limit reached ∙ resets 10am (America/Chicago)', 0),
    '5-hour limit reached ∙ resets 10am (America/Chicago)')
})

test("Codex's limit arrives on stderr", () => {
  const log = "[forge] starting codex agent in /repo\n[stderr] ERROR: You've hit your usage limit. Try again at Dec 1st, 2026 12:00 AM.\n"
  assert.equal(usageLimitLine(log, 1), "ERROR: You've hit your usage limit. Try again at Dec 1st, 2026 12:00 AM.")
})

test('ordinary failures and real work that mentions limits are not limit stops', () => {
  assert.equal(usageLimitLine('[forge] starting claude agent\nTypeError: boom\n', 1), null)
  const work = 'Implemented the parser.\n'.repeat(40) + 'Added a test for "usage limit reached" handling.\n'
  assert.equal(usageLimitLine(work, 0), null)
})

test('fallback lists are validated', () => {
  assert.equal(validFallbacks(undefined), undefined)
  assert.deepEqual(validFallbacks([{ provider: 'codex', promptNote: 'use Atlas in Chrome' }]), [{ provider: 'codex', promptNote: 'use Atlas in Chrome' }])
  assert.equal(validFallbacks([{ provider: 'gpt' }]), 'invalid')
  assert.equal(validFallbacks([{ provider: 'codex' }, { provider: 'codex' }]), 'invalid')
  assert.equal(validFallbacks('codex'), 'invalid')
})

test('the continued prompt keeps the brief and says how to pick up the partial work', () => {
  const prompt = continuedPrompt('Fix the chart in the browser', 'claude', { provider: 'codex', promptNote: 'For browser work use Atlas in Chrome.' }, 'Claude AI usage limit reached|1')
  assert.match(prompt, /^Fix the chart in the browser\n\n\[Atlas failover\] Claude Code stopped because it ran out of usage/)
  assert.match(prompt, /continuing on Codex/)
  assert.match(prompt, /\[Atlas engine note\] For browser work use Atlas in Chrome\.$/)
})
