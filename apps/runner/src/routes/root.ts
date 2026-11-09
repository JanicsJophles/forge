import { Router } from 'express'
import { version } from '../version.js'

export const rootRouter = Router()

// Escape the handful of characters that could break out of HTML text/attribute
// context. The only interpolated value is the build version, but it can carry a
// git SHA from operator config, so never trust it raw.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Documented, operator-facing endpoints a human browsing the box should see
// first. Kept deliberately short — this is a signpost, not the full API.
const ENDPOINTS: Array<{ path: string; desc: string }> = [
  { path: '/health', desc: 'liveness + capacity + disk' },
  { path: '/capabilities', desc: 'providers + limits contract' },
  { path: '/tasks', desc: 'recent tasks' },
  { path: '/repos', desc: 'allowed git repos' },
  { path: '/agent-context', desc: 'live agents + recent events' },
]

function landingHtml(): string {
  const safeVersion = escapeHtml(version)
  const rows = ENDPOINTS.map(
    ({ path, desc }) =>
      `      <li><a href="${path}"><code>${path}</code></a> — ${escapeHtml(desc)}</li>`,
  ).join('\n')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Forge runner</title>
  </head>
  <body>
    <h1>Forge</h1>
    <p>Self-hosted Claude Code agent runner — version <code>${safeVersion}</code></p>
    <p><a href="/dashboard">Open the dashboard →</a></p>
    <h2>Endpoints</h2>
    <ul>
${rows}
    </ul>
  </body>
</html>
`
}

// Read-only signpost at the base URL so the root is not a bare 404. No state
// change, no auth: GET stays open even when FORGE_AUTH_TOKEN is set.
rootRouter.get('/', (_req, res) => {
  res.type('html').send(landingHtml())
})
