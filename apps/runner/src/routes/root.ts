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
    <!--
      Live status, filled in by the script below from GET /health on each page
      load (static render shows "…" so the page is never blank if JS is off or
      the fetch fails). Every server value is written via textContent only, so a
      hostile /health payload can never inject markup here.
    -->
    <h2>Status</h2>
    <ul>
      <li>Accepting work: <strong id="accepting">…</strong></li>
      <li>Slots in use: <span id="slots">…</span></li>
      <li>Uptime: <span id="uptime">…</span></li>
      <li>Reported version: <code id="live-version">…</code></li>
    </ul>
    <h2>Endpoints</h2>
    <ul>
${rows}
    </ul>
    <script>
      (function () {
        function fmtUptime(seconds) {
          if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) {
            return 'unknown'
          }
          var s = Math.floor(seconds)
          var d = Math.floor(s / 86400)
          var h = Math.floor((s % 86400) / 3600)
          var m = Math.floor((s % 3600) / 60)
          var parts = []
          if (d) parts.push(d + 'd')
          if (h) parts.push(h + 'h')
          if (m) parts.push(m + 'm')
          parts.push((s % 60) + 's')
          return parts.join(' ')
        }
        function setText(id, value) {
          var el = document.getElementById(id)
          if (el) el.textContent = value
        }
        fetch('/health', { headers: { accept: 'application/json' } })
          .then(function (r) {
            if (!r.ok) throw new Error('health ' + r.status)
            return r.json()
          })
          .then(function (h) {
            var accepting = h.acceptingTasks === true
            setText('accepting', accepting ? 'yes' : 'no')
            var used = h.queuedOrRunning
            var max = h.maxConcurrentTasks
            if (typeof used === 'number' && typeof max === 'number') {
              setText('slots', used + ' / ' + max)
            } else {
              setText('slots', 'unknown')
            }
            setText('uptime', fmtUptime(h.uptimeSeconds))
            setText('live-version', typeof h.version === 'string' ? h.version : 'unknown')
          })
          .catch(function () {
            setText('accepting', 'unknown (health unreachable)')
            setText('slots', 'unknown')
            setText('uptime', 'unknown')
            setText('live-version', 'unknown')
          })
      })()
    </script>
  </body>
</html>
`
}

// Read-only signpost at the base URL so the root is not a bare 404. No state
// change, no auth: GET stays open even when FORGE_AUTH_TOKEN is set.
rootRouter.get('/', (_req, res) => {
  res.type('html').send(landingHtml())
})
