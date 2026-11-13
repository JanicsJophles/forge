import { Router } from 'express'
import { version } from '../version.js'
import { config } from '../config.js'
import { RETENTION_INTERVAL_MS } from '../db/retention.js'

export const rootRouter = Router()

// Escape the handful of characters that could break out of HTML text/attribute
// context. The build version can carry a
// git SHA from operator config, so never trust it raw.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Human-readable suffix for WHY the runner is not accepting work, keyed by the
// machine-readable notAcceptingReason from GET /health. Single source of truth:
// serialized into the client script below AND consumed by acceptingLabel, so the
// page text and the unit tests can never drift from each other. Values are fixed
// constants with no HTML-special characters, so embedding them is injection-safe.
const NOT_ACCEPTING_LABELS: Record<string, string> = {
  concurrency: 'at capacity',
  disk: 'low disk',
  dataDisk: 'low data-disk',
  unknown: 'disk unmeasured',
}

// Map a /health acceptance verdict to the text shown next to "Accepting work".
// Exported so the reason-mapping branches are unit-testable without executing the
// embedded client script. An accepting box stays 'yes'; a refusal appends the
// human reason ('no (at capacity)') when notAcceptingReason is a known code, and
// degrades to a bare 'no' when the code is missing or unrecognised.
export function acceptingLabel(accepting: boolean, reason: string | null): string {
  if (accepting) return 'yes'
  const suffix = reason != null ? NOT_ACCEPTING_LABELS[reason] : undefined
  return suffix ? `no (${suffix})` : 'no'
}

// Documented, operator-facing endpoints a human browsing the box should see
// first. Kept deliberately short — this is a signpost, not the full API.
const ENDPOINTS: Array<{ path: string; desc: string }> = [
  { path: '/health', desc: 'liveness + capacity + disk' },
  { path: '/capabilities', desc: 'providers + limits contract' },
  { path: '/tasks', desc: 'recent tasks' },
  { path: '/history', desc: 'browse task history' },
  { path: '/repos', desc: 'allowed git repos' },
  { path: '/agent-context', desc: 'live agents + recent events' },
]

function landingHtml(): string {
  const safeVersion = escapeHtml(version)
  const authMode = config.authToken
    ? 'Mutations (launches, retries and cancellations) require a bearer token.'
    : 'Mutation authentication is disabled.'
  const retentionPolicy = config.retentionDays === 0
    ? 'History retention pruning is disabled (0 days).'
    : `History retention: terminal runs (completed or failed) older than ${config.retentionDays} days are eligible for pruning at startup and every ${RETENTION_INTERVAL_MS / 3_600_000} hours.`
  // The reason labels are fixed ASCII constants, so this never contains a
  // </script> sequence; written into the inline script as the single source of
  // truth for the "Accepting work" suffix mapping.
  const reasonLabelsJson = JSON.stringify(NOT_ACCEPTING_LABELS)
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
    <p id="mutation-auth-mode">${authMode} Use the <a href="/dashboard">dashboard</a> for task actions. Read views remain accessible.</p>
    <!--
      Live status, refreshed from GET /health five seconds after each completed
      refresh cycle (static render shows "…" so the page is never blank if JS is off or
      the fetch fails). Every server value is written via textContent only, so a
      hostile /health payload can never inject markup here.
    -->
    <h2>Status</h2>
    <p id="health-freshness" role="status">Health unavailable — waiting for first update.</p>
    <ul>
      <li>Accepting work: <strong id="accepting">…</strong></li>
      <li>Slots in use: <span id="slots">…</span></li>
      <li>Repository volume free: <span id="repo-disk">…</span></li>
      <li>Database volume free: <span id="data-disk">…</span></li>
      <li>Minimum free disk required: <span id="min-disk">…</span></li>
      <li>Uptime: <span id="uptime">…</span></li>
      <li>Reported version: <code id="live-version">…</code></li>
      <li>Oldest running age: <span id="oldest-running-age">…</span></li>
      <li>Provider runtime limit: <span id="task-timeout">…</span></li>
    </ul>
    <p>The provider runtime limit is a termination deadline, not a guaranteed completion or free-slot time. Queued work has not necessarily started.</p>
    <h2>Recent tasks</h2>
    <p id="history-retention">${escapeHtml(retentionPolicy)} Queued and running tasks are retained.
      Pruning makes SQLite pages reusable; it does not shrink the database file.
      <a href="/history">Browse task history</a>.</p>
    <p id="tasks-freshness" role="status">Recent tasks unavailable — waiting for first update.</p>
    <p>Refreshes five seconds after each completed update.</p>
    <ul id="recent-tasks" aria-live="polite"><li>recent tasks unavailable</li></ul>
    <h2>Retained task history</h2>
    <p>Counts describe retained records, not lifetime totals or scheduling guarantees.</p>
    <p id="totals-freshness" role="status">Task totals unavailable — waiting for first update.</p>
    <p>
      <a href="/history">Total: <span id="total-total">…</span></a> ·
      <a href="/history?status=completed">Completed: <span id="total-completed">…</span></a> ·
      <a href="/history?status=failed">Failed: <span id="total-failed">…</span></a> ·
      <a href="/history?status=queued">Queued: <span id="total-queued">…</span></a> ·
      <a href="/history?status=running">Running: <span id="total-running">…</span></a>
    </p>
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
        function fmtDisk(value) {
          return typeof value === 'number' && isFinite(value) && value >= 0
            ? value + ' MiB' : 'unknown'
        }
        function setDisk(h) {
          setText('repo-disk', fmtDisk(h.freeDiskMb))
          setText('data-disk', fmtDisk(h.dataFreeDiskMb))
          setText('min-disk', fmtDisk(h.minFreeDiskMb))
        }
        function setText(id, value) {
          var el = document.getElementById(id)
          if (el) el.textContent = value
        }
        var hasHealth = false
        var hasTasks = false
        var hasTotals = false
        // Keep ownership until the actual transport/body settles, even after a
        // deadline. Abort-ignoring transports must not accumulate every cycle.
        var pendingReads = Object.create(null)
        function readJson(url) {
          if (pendingReads[url]) return Promise.reject(new Error('read still pending'))
          var controller = new AbortController()
          var owner = {}
          pendingReads[url] = owner
          return new Promise(function (resolve, reject) {
            var expired = false
            var timer = setTimeout(function () {
              expired = true
              reject(new Error('read deadline'))
              controller.abort()
            }, 10000)
            Promise.resolve().then(function () {
              return fetch(url, {
                cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal
              })
            }).then(function (response) {
              if (expired) throw new Error('read expired')
              if (!response.ok) throw new Error('read ' + response.status)
              return response.json()
            }).then(function (value) {
              finish()
              if (!expired) resolve(value)
            }, function (error) {
              finish()
              if (!expired) reject(error)
            })
            function finish() {
              clearTimeout(timer)
              if (pendingReads[url] === owner) delete pendingReads[url]
            }
          })
        }
        function validTask(task) {
          if (!task || typeof task !== 'object' || Array.isArray(task)) return false
          if (typeof task.id !== 'string' || !task.id.trim() || /^\\.+$/.test(task.id)) return false
          try { encodeURIComponent(task.id) } catch (_) { return false }
          if (['queued', 'running', 'completed', 'failed'].indexOf(task.status) === -1) return false
          // Optional displayed metadata may be absent, but must never be objects
          // or coerced proxy garbage. Validate prompt metadata for intent previews.
          if (!['repo', 'branch', 'prompt', 'createdAt', 'startedAt', 'completedAt', 'provider']
            .every(function (key) { return task[key] == null || typeof task[key] === 'string' })) return false
          if (task.promptTruncated != null && typeof task.promptTruncated !== 'boolean') return false
          if (task.promptBytes != null && (typeof task.promptBytes !== 'number' ||
            !isFinite(task.promptBytes) || task.promptBytes < 0 || Math.floor(task.promptBytes) !== task.promptBytes)) return false
          return true
        }
        function refreshTasks() {
          return readJson('/tasks?limit=5')
          .then(function (tasks) {
            if (!Array.isArray(tasks)) throw new Error('invalid tasks')
            var boundedTasks = tasks.slice(0, 5)
            if (!boundedTasks.every(validTask)) throw new Error('invalid task row')
            var list = document.getElementById('recent-tasks')
            var rows = boundedTasks.map(function (task) {
              var row = document.createElement('li')
              var id = typeof task.id === 'string' ? task.id.slice(0, 8) : 'unknown'
              var repo = typeof task.repo === 'string'
                ? task.repo.split('/').filter(Boolean).pop() || 'unknown' : 'unknown'
              var status = typeof task.status === 'string' ? task.status : 'unknown'
              var prompt = typeof task.prompt === 'string' ? task.prompt.replace(/\\s+/gu, ' ').trim() : ''
              var characters = Array.from(prompt)
              var truncated = characters.length > 160 || task.promptTruncated === true
              var preview = prompt ? characters.slice(0, truncated ? 159 : 160).join('') +
                (truncated ? '…' : '') : 'Saved prompt unavailable' + (truncated ? '…' : '')
              row.textContent = id + ' — ' + repo + ' — ' + status +
                ' — ' + preview + ' — Task ID: ' +
                (typeof task.id === 'string' && task.id.trim() ? task.id : 'unavailable') +
                ' — Repository: ' +
                (typeof task.repo === 'string' && task.repo.trim() ? task.repo : 'unavailable')
              if (typeof task.id === 'string' && task.id.trim() && !/^\\.+$/.test(task.id)) {
                try {
                  var link = document.createElement('a')
                  link.href = '/tasks/' + encodeURIComponent(task.id) + '/log/view'
                  link.textContent = ' View logs'
                  row.appendChild(link)
                } catch (_) {
                  // Malformed Unicode cannot form an encoded path segment.
                }
              }
              return row
            })
            list.textContent = ''
            if (!rows.length) {
              var empty = document.createElement('li')
              empty.textContent = 'No recent tasks'
              rows.push(empty)
            }
            rows.forEach(function (row) { list.appendChild(row) })
            hasTasks = true
            setText('tasks-freshness', '')
          })
          .catch(function () {
            if (!hasTasks) setText('recent-tasks', 'recent tasks unavailable')
            setText('tasks-freshness', hasTasks
              ? 'Recent tasks stale — refresh unavailable.' : 'Recent tasks unavailable — retrying.')
          })
        }
        function refreshTotals() {
          return readJson('/tasks/stats').then(function (counts) {
            var keys = ['total', 'completed', 'failed', 'queued', 'running']
            if (!counts || typeof counts !== 'object' || Array.isArray(counts) ||
                !keys.every(function (key) {
                  return typeof counts[key] === 'number' && Number.isSafeInteger(counts[key]) && counts[key] >= 0
                }) || counts.total !== counts.completed + counts.failed + counts.queued + counts.running) {
              throw new Error('invalid task totals')
            }
            keys.forEach(function (key) { setText('total-' + key, String(counts[key])) })
            hasTotals = true
            setText('totals-freshness', '')
          }).catch(function () {
            setText('totals-freshness', hasTotals
              ? 'Task totals stale — refresh unavailable.' : 'Task totals unavailable — retrying.')
          })
        }
        function refreshHealth() {
          return readJson('/health')
          .then(function (h) {
            if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error('invalid health')
            // Validate required admission data before publishing any part of the panel.
            if (typeof h.acceptingTasks !== 'boolean' ||
                !Number.isSafeInteger(h.queuedOrRunning) || h.queuedOrRunning < 0 ||
                !Number.isSafeInteger(h.maxConcurrentTasks) || h.maxConcurrentTasks <= 0) {
              throw new Error('invalid health admission data')
            }
            var accepting = h.acceptingTasks
            var reasonLabels = ${reasonLabelsJson}
            var reason =
              typeof h.notAcceptingReason === 'string' ? h.notAcceptingReason : null
            var suffix =
              !accepting && reason && reasonLabels[reason]
                ? ' (' + reasonLabels[reason] + ')'
                : ''
            setText('accepting', (accepting ? 'yes' : 'no') + suffix)
            var used = h.queuedOrRunning
            var max = h.maxConcurrentTasks
            if (typeof used === 'number' && typeof max === 'number') {
              setText('slots', used + ' / ' + max)
            } else {
              setText('slots', 'unknown')
            }
            setDisk(h)
            setText('uptime', fmtUptime(h.uptimeSeconds))
            setText('live-version', typeof h.version === 'string' ? h.version : 'unknown')
            setText('oldest-running-age', h.oldestRunningTaskAgeSeconds === null
              ? 'no measured running age' : fmtUptime(h.oldestRunningTaskAgeSeconds))
            var timeout = h.taskTimeoutMs
            setText('task-timeout', typeof timeout === 'number' && isFinite(timeout) && timeout >= 0
              ? fmtUptime(timeout / 1000) : 'unknown')
            hasHealth = true
            setText('health-freshness', '')
          })
          .catch(function () {
            setText('health-freshness', hasHealth
              ? 'Health stale — refresh unavailable.' : 'Health unavailable — retrying.')
            if (hasHealth) return
            setText('accepting', 'unknown (health unreachable)')
            setText('slots', 'unknown')
            setDisk({})
            setText('uptime', 'unknown')
            setText('live-version', 'unknown')
            setText('oldest-running-age', 'unknown')
            setText('task-timeout', 'unknown')
          })
        }
        function refresh() {
          // Each update settles by its deadline, independently of transport abort.
          // readJson retains ownership of any underlying read still pending.
          Promise.all([refreshTasks(), refreshHealth(), refreshTotals()]).then(function () {
            setTimeout(refresh, 5000)
          })
        }
        refresh()
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
