// ---------------------------------------------------------------------------
// GET /tasks/:id/log/view — a live, human-facing log viewer.
//
// The dashboard's raw "log" link opens /tasks/:id/log?format=text: a static
// byte dump with no tail-follow. This page instead connects to the existing
// /tasks/:id/stream SSE endpoint (catch-up frame + live events), renders each
// log chunk in order, and autoscrolls to the bottom unless the reader has
// scrolled up to inspect earlier output.
//
// Security: the only interpolated value is the task id. It is placed into HTML
// text via escapeHtml, into href attributes via encodeURIComponent (which
// cannot emit markup metacharacters), and into the inline script only as a
// JSON string literal with '<' hardened to \u003c so a crafted id can never
// break out of the <script> block. The client appends log text with
// createTextNode only — never innerHTML — so stream payloads cannot inject
// markup either. Mirrors the conventions in root.ts and dashboard.ts.
// ---------------------------------------------------------------------------

import { Router } from 'express'
import { db } from '../db/schema.js'
import { readTaskStatusMeta } from '../db/task-log.js'

export const taskLogViewRouter = Router()

// Escape the characters that could break out of an HTML text or attribute
// context. Used for every server-interpolated value that lands in markup.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function viewHtml(id: string): string {
  const safeId = escapeHtml(id)
  const encodedId = encodeURIComponent(id)
  const streamPath = `/tasks/${encodedId}/stream`
  const rawHref = escapeHtml(`/tasks/${encodedId}/log?format=text`)
  const downloadHref = escapeHtml(`/tasks/${encodedId}/log?format=text&download=1`)
  // JSON.stringify yields a valid JS string literal; hardening '<' to \u003c
  // means a '</script>' inside the id can never close the inline block.
  const streamLiteral = JSON.stringify(streamPath).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>forge · log ${safeId}</title>
    <style>
      :root {
        --bg: #030712;
        --panel: #0a0f1e;
        --border: #1a2238;
        --text: #e4e4e7;
        --text-dim: #71717a;
        --accent: #10b981;
        --warn: #f59e0b;
        --fail: #ef4444;
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; margin: 0; }
      body {
        display: flex;
        flex-direction: column;
        background: var(--bg);
        color: var(--text);
        font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      }
      header {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        padding: 12px 20px;
        border-bottom: 1px solid var(--border);
        background: var(--panel);
      }
      header h1 { margin: 0; font-size: 14px; font-weight: 600; }
      header .id { color: var(--accent); font-family: 'SF Mono', Menlo, monospace; }
      header a { color: var(--accent); text-decoration: none; font-size: 12px; }
      header a:hover { text-decoration: underline; }
      .spacer { flex: 1 1 auto; }
      #status {
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: rgba(59, 130, 246, 0.2);
        color: #3b82f6;
      }
      #status.done { background: rgba(16, 185, 129, 0.2); color: var(--accent); }
      #status.fail { background: rgba(239, 68, 68, 0.2); color: var(--fail); }
      #status.warn { background: rgba(245, 158, 11, 0.2); color: var(--warn); }
      #log {
        flex: 1 1 auto;
        margin: 0;
        padding: 12px 20px;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-family: 'SF Mono', Menlo, monospace;
        font-size: 12px;
        line-height: 1.5;
      }
      #empty { color: var(--text-dim); }
      footer {
        padding: 8px 20px;
        border-top: 1px solid var(--border);
        color: var(--text-dim);
        font-size: 11px;
      }
    </style>
  </head>
  <body>
    <header>
      <h1>forge log · <span class="id">${safeId}</span></h1>
      <span id="status" role="status" aria-live="polite">connecting…</span>
      <div class="spacer"></div>
      <a href="${rawHref}">raw text</a>
      <a href="${downloadHref}">download</a>
      <a href="/dashboard">dashboard</a>
    </header>
    <pre id="log"><span id="empty">waiting for output…</span></pre>
    <footer>Live tail via <code>/tasks/:id/stream</code> · scroll up to pause autoscroll</footer>
    <script>
      (function () {
        var STREAM_URL = ${streamLiteral};
        var logEl = document.getElementById('log');
        var statusEl = document.getElementById('status');
        var emptyEl = document.getElementById('empty');
        var done = false;
        function setStatus(text, cls) {
          statusEl.textContent = text;
          statusEl.className = cls || '';
        }
        function atBottom() {
          // Treat "within 24px of the end" as pinned so a trailing newline or
          // sub-pixel rounding never un-sticks the autoscroll.
          return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight <= 24;
        }
        function appendLog(text) {
          if (typeof text !== 'string' || text.length === 0) return;
          if (emptyEl) { emptyEl.remove(); emptyEl = null; }
          var pinned = atBottom();
          // createTextNode (never innerHTML) keeps stream payloads inert.
          logEl.appendChild(document.createTextNode(text));
          if (pinned) logEl.scrollTop = logEl.scrollHeight;
        }
        function parse(data) {
          // Stream frames carry JSON.stringify'd strings; recover the raw text,
          // falling back to the verbatim payload if a frame is not valid JSON.
          try {
            var value = JSON.parse(data);
            return typeof value === 'string' ? value : data;
          } catch (e) {
            return data;
          }
        }
        var source;
        try {
          source = new EventSource(STREAM_URL);
        } catch (e) {
          setStatus('unavailable', 'fail');
          return;
        }
        source.addEventListener('open', function () {
          if (!done) setStatus('streaming', '');
        });
        source.addEventListener('log', function (e) {
          appendLog(parse(e.data));
        });
        source.addEventListener('status', function (e) {
          if (!done) setStatus(parse(e.data) || 'streaming', '');
        });
        source.addEventListener('complete', function () {
          done = true;
          setStatus('completed', 'done');
          source.close();
        });
        source.addEventListener('error', function (e) {
          // The server's named 'error' frame is a MessageEvent carrying .data;
          // a bare connection drop is a plain Event with none. Only the former
          // is a terminal task failure — the latter lets EventSource retry.
          if (e && typeof e.data === 'string') {
            done = true;
            appendLog(parse(e.data));
            setStatus('failed', 'fail');
            source.close();
          } else if (!done) {
            setStatus('reconnecting…', 'warn');
          }
        });
      })();
    </script>
  </body>
</html>
`
}

// GET /tasks/:id/log/view — a distinct path segment from /:id/log, so it never
// shadows (nor is shadowed by) the byte-slice log route. A missing task id gets
// the same { error: 'task not found' } JSON 404 the sibling routes return;
// readTaskStatusMeta is a narrow existence probe (no full-log read).
taskLogViewRouter.get('/:id/log/view', (req, res) => {
  if (!readTaskStatusMeta(db, req.params.id)) {
    res.status(404).json({ error: 'task not found' })
    return
  }
  res.type('html').send(viewHtml(req.params.id))
})
