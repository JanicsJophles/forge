import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { dashboardRouter } from './dashboard.js'

test('served dashboard inputs have persistent associated labels and launch help', async () => {
  const server = express().use(dashboardRouter).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  let html: string
  try {
    const { port } = server.address() as { port: number }
    html = await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  const markup = html.split('<script>')[0]
  for (const [id, tag, label] of [
    ['launchPrompt', 'textarea', 'Prompt (required)'],
    ['launchModel', 'input', 'Model (optional)'],
    ['agentFilter', 'select', 'Agent (checkpoints and events only)'],
    ['ticketFilter', 'select', 'Ticket (agents and events only)'],
    ['authToken', 'input', 'Auth token'],
  ]) {
    assert.ok(markup.includes(`<label for="${id}">${label}</label>`), `${id} has a visible label`)
    assert.equal([...markup.matchAll(new RegExp(`<${tag}\\b[^>]*\\bid="${id}"`, 'g'))].length, 1)
  }
  for (const [id, tag, helpId, description] of [
    ['launchPrompt', 'textarea', 'launchPromptHelp', 'Describe what the agent should do. A prompt containing more than whitespace is required.'],
    ['launchModel', 'input', 'launchModelHelp', 'Model is optional. Leave it blank to use the selected provider’s default model.'],
  ]) {
    assert.match(markup, new RegExp(`<${tag}\\b[^>]*id="${id}"[^>]*aria-describedby="${helpId}"`))
    assert.ok(markup.includes(`<p id="${helpId}" class="launch-help">${description}</p>`))
    assert.equal([...markup.matchAll(new RegExp(`\\bid="${helpId}"`, 'g'))].length, 1)
  }
  // No new focus stops or native validation: the existing submit handler keeps
  // ownership of prompt validation, draft retention and dispatch deadlines.
  const prompt = markup.match(/<textarea\b[^>]*id="launchPrompt"[^>]*>/)![0]
  assert.doesNotMatch(prompt, /\b(?:required|tabindex)=?/)
  assert.match(markup, /\.launch-help\s*\{[^}]*overflow-wrap: anywhere/)
})
