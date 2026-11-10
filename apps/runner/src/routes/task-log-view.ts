// ---------------------------------------------------------------------------
// GET /tasks/:id/log/view — a live, human-facing log viewer.
//
// The dashboard's raw "log" link opens /tasks/:id/log?format=text: a static
// byte dump with no tail-follow. This page instead connects to the existing
// /tasks/:id/stream SSE endpoint (catch-up frame + live events), renders each
// log chunk in order, and autoscrolls to the bottom unless the reader has
// scrolled up to inspect earlier output.
//
// Security: metadata is escaped as HTML text. The task id is placed into HTML
// text via escapeHtml, into href attributes via encodeURIComponent (which
// cannot emit markup metacharacters), and into the inline script only as a
// JSON string literal with '<' hardened to \u003c so a crafted id can never
// break out of the <script> block. The client appends log text with
// createTextNode only — never innerHTML — so stream payloads cannot inject
// markup either. Mirrors the conventions in root.ts and dashboard.ts.
// ---------------------------------------------------------------------------

import { Router } from 'express'
import { db } from '../db/schema.js'

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

interface LaunchMeta {
  status: string | null
  repo: string | null
  branch: string | null
  provider: string | null
  model: string | null
  auto_commit: number | null
}

function viewHtml(id: string, meta: LaunchMeta): string {
  const configuration = [
    ['Repository', meta.repo],
    ['Branch', meta.branch],
    ['Provider', meta.provider],
    ['Model', meta.model],
    ['Auto commit', meta.auto_commit == null ? null : meta.auto_commit === 0 ? 'off' : 'on'],
  ].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value ?? 'unspecified')}</dd></div>`).join('')
  const safeId = escapeHtml(id)
  const encodedId = encodeURIComponent(id)
  const streamPath = `/tasks/${encodedId}/stream`
  const rawHref = escapeHtml(`/tasks/${encodedId}/log?format=text`)
  const downloadHref = escapeHtml(`/tasks/${encodedId}/log?format=text&download=1`)
  // JSON.stringify yields a valid JS string literal; hardening '<' to \u003c
  // means a '</script>' inside the id can never close the inline block.
  const streamLiteral = JSON.stringify(streamPath).replace(/</g, '\\u003c')
  const statusLiteral = JSON.stringify(meta.status ?? '').replace(/</g, '\\u003c')
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
      .configuration { flex-basis: 100%; overflow-wrap: anywhere; }
      .configuration summary { cursor: pointer; }
      .configuration dl { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 8px 0 0; }
      .configuration dt { color: var(--text-dim); }
      .configuration dd { margin: 2px 0 0; }
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
      #findForm { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 20px; }
      #findScope { flex-basis: 100%; color: var(--text-dim); }
      #empty { color: var(--text-dim); }
      #omitted { margin: 0; padding: 8px 20px; color: var(--warn); }
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
      <label for="authToken">Auth token</label>
      <input type="password" id="authToken" placeholder="Bearer token" autocomplete="off" />
      <button type="button" id="cancel" hidden>Cancel</button>
      <button type="button" id="retry" hidden>Retry</button>
      <span id="actionMessage" role="status" aria-live="polite"></span>
      <div class="spacer"></div>
      <a href="${rawHref}">raw text</a>
      <a href="${downloadHref}">download</a>
      <a href="/dashboard">dashboard</a>
      <details class="configuration"><summary>Launch configuration</summary><dl>${configuration}</dl></details>
    </header>
    <form id="findForm" role="search">
      <label for="findText">Find literal text in currently retained log</label>
      <input id="findText" type="text" aria-describedby="findScope" autocomplete="off" />
      <button id="findPrevious" type="button" disabled>Find previous</button>
      <button id="findNext" type="submit" disabled>Find next</button>
      <span id="findResult" role="status" aria-live="polite">Enter text to find</span>
      <span id="findScope">Case-sensitive; retained output only. Earlier omitted output is not searched. Enter: next; Shift+Enter: previous. Clear to resume tail-follow.</span>
    </form>
    <p id="omitted" role="status" hidden>Earlier displayed output omitted. Use raw text or download for the stored log.</p>
    <p id="replayNotice" role="status" hidden>Reconnected: earlier displayed output was replaced with a fresh server replay. Only the stored tail may be available.</p>
    <pre id="log"><span id="empty">waiting for output…</span></pre>
    <footer>Live tail via <code>/tasks/:id/stream</code> · scroll up to pause autoscroll</footer>
    <script>
      (function () {
        var STREAM_URL = ${streamLiteral};
        var logEl = document.getElementById('log');
        var statusEl = document.getElementById('status');
        var emptyEl = document.getElementById('empty');
        var cancelEl = document.getElementById('cancel');
        var retryEl = document.getElementById('retry');
        var tokenEl = document.getElementById('authToken');
        var messageEl = document.getElementById('actionMessage');
        var taskUrl = STREAM_URL.slice(0, -'/stream'.length);
        // 128K UTF-16 code units = at most 256 KiB of retained text.
        // A single text node also bounds DOM size for tiny SSE frames.
        var MAX_LOG_UNITS = 128 * 1024;
        var transcript = null;
        var omittedEl = document.getElementById('omitted');
        var findEl = document.getElementById('findText');
        var findResult = document.getElementById('findResult');
        var findNext = document.getElementById('findNext');
        var findPrevious = document.getElementById('findPrevious');
        var selectedStart = -1;
        var matchCount = 0;
        var findRange = null;
        function clearFindRange() {
          if (!findRange) return;
          var selection = window.getSelection();
          if (selection) {
            for (var i = selection.rangeCount - 1; i >= 0; i--) {
              if (selection.getRangeAt(i) === findRange) selection.removeRange(findRange);
            }
          }
          findRange = null;
        }
        // Scan the bounded text directly: no regex, match arrays, or DOM wrappers.
        function updateFind(target, reveal) {
          clearFindRange();
          var text = transcript ? transcript.textContent : '';
          var query = findEl.value;
          var chosen = -1;
          var current = 0;
          matchCount = 0;
          if (query) {
            for (var at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) {
              matchCount++;
              if (chosen === -1 || (chosen < target && at <= target)) {
                chosen = at;
                current = matchCount;
              }
            }
          }
          selectedStart = chosen;
          findNext.disabled = findPrevious.disabled = matchCount === 0;
          findResult.textContent = !query ? 'Enter text to find' : !matchCount ?
            'No matches in retained log' : current + ' / ' + matchCount + ' in retained log';
          if (chosen < 0) return;
          findRange = document.createRange();
          findRange.setStart(transcript, chosen);
          findRange.setEnd(transcript, chosen + query.length);
          var selection = window.getSelection();
          if (selection) { selection.removeAllRanges(); selection.addRange(findRange); }
          if (reveal) {
            var rect = findRange.getBoundingClientRect();
            var viewport = logEl.getBoundingClientRect();
            logEl.scrollTop += rect.top - viewport.top - logEl.clientHeight / 2;
          }
        }
        function navigateFind(backwards) {
          var text = transcript ? transcript.textContent : '';
          var query = findEl.value;
          if (!query) return;
          var target = backwards ? text.lastIndexOf(query, selectedStart - 1) :
            text.indexOf(query, selectedStart + query.length);
          if (backwards && selectedStart <= 0) target = -1;
          if (target < 0) target = backwards ? text.lastIndexOf(query) : 0;
          updateFind(target, true);
        }
        findEl.oninput = function () { updateFind(0, true); };
        document.getElementById('findForm').onsubmit = function (event) {
          event.preventDefault();
          navigateFind(false);
        };
        findEl.onkeydown = function (event) {
          if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            navigateFind(true);
          }
        };
        findPrevious.onclick = function () { navigateFind(true); };
        var done = false;
        var statusVersion = 0;
        try { tokenEl.value = sessionStorage.getItem('forge.authToken') || ''; } catch (e) {}
        tokenEl.oninput = function () {
          try {
            var token = tokenEl.value.trim();
            if (token) sessionStorage.setItem('forge.authToken', token);
            else sessionStorage.removeItem('forge.authToken');
          } catch (e) {}
        };
        function taskStatus(status) {
          statusVersion++;
          cancelEl.hidden = status !== 'running' && status !== 'queued';
          retryEl.hidden = status !== 'completed' && status !== 'failed';
          setStatus(status, status === 'completed' ? 'done' : status === 'failed' ? 'fail' : '');
        }
        async function refreshStatus() {
          var version = statusVersion;
          var response = await fetch(taskUrl + '?view=status');
          if (!response.ok) throw new Error('Status refresh failed (HTTP ' + response.status + ')');
          var task = await response.json();
          // A newer stream event takes precedence over an in-flight read.
          if (version === statusVersion) taskStatus(task.status);
        }
        async function action(retry) {
          cancelEl.disabled = retryEl.disabled = true;
          messageEl.textContent = '';
          try {
            var token = tokenEl.value.trim();
            var response = await fetch(taskUrl + (retry ? '/retry' : ''), {
              method: retry ? 'POST' : 'DELETE',
              headers: token ? { Authorization: 'Bearer ' + token } : {}
            });
            var result = await response.json();
            if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + (result.error || 'Action failed'));
            if (retry) {
              var link = document.createElement('a');
              link.href = '/tasks/' + encodeURIComponent(result.taskId) + '/log/view';
              link.textContent = 'Open retried task';
              messageEl.appendChild(link);
            } else {
              messageEl.textContent = 'Cancellation requested';
              await refreshStatus();
            }
          } catch (e) {
            messageEl.textContent = e.message;
          } finally {
            cancelEl.disabled = retryEl.disabled = false;
          }
        }
        cancelEl.onclick = function () { return action(false); };
        retryEl.onclick = function () { return action(true); };
        taskStatus(${statusLiteral});
        refreshStatus().catch(function (e) { messageEl.textContent = e.message; });
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
          var pinned = atBottom() && selectedStart < 0;
          clearFindRange();
          var previousTop = logEl.scrollTop;
          if (emptyEl) { emptyEl.remove(); emptyEl = null; }
          if (!transcript) {
            // createTextNode (never innerHTML) keeps stream payloads inert.
            transcript = document.createTextNode('');
            logEl.appendChild(transcript);
          }
          var previous = transcript.textContent;
          var combined = previous + text;
          var cut = Math.max(0, combined.length - MAX_LOG_UNITS);
          // Never retain half of a surrogate pair, including across frames.
          if (cut > 0 && combined.charCodeAt(cut) >= 0xdc00 &&
              combined.charCodeAt(cut) <= 0xdfff &&
              combined.charCodeAt(cut - 1) >= 0xd800 &&
              combined.charCodeAt(cut - 1) <= 0xdbff) cut++;
          var removedHeight = 0;
          if (cut > 0) {
            omittedEl.hidden = false;
            var oldHeight = logEl.scrollHeight;
            // Measure only the removed prefix, before adding new output.
            transcript.textContent = previous.slice(Math.min(cut, previous.length));
            removedHeight = oldHeight - logEl.scrollHeight;
          }
          transcript.textContent = combined.slice(cut);
          updateFind(Math.max(0, selectedStart - cut), false);
          if (pinned) logEl.scrollTop = logEl.scrollHeight;
          else logEl.scrollTop = Math.max(0, previousTop - removedHeight);
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
        var opened = false;
        var source;
        try {
          source = new EventSource(STREAM_URL);
        } catch (e) {
          setStatus('unavailable', 'fail');
          return;
        }
        source.addEventListener('open', function () {
          if (done) return;
          if (opened) {
            // Each connection starts with a fresh server tail, not a resume.
            // Clear text in place so a retained transcript node (DOM cap) stays valid.
            clearFindRange();
            Array.from(logEl.childNodes).forEach(function (node, index) {
              if (index === 0) node.textContent = '';
              else node.remove();
            });
            updateFind(0, false);
            document.getElementById('replayNotice').hidden = false;
            var omitted = document.getElementById('omitted');
            if (omitted) omitted.hidden = true;
          }
          opened = true;
          setStatus('streaming', '');
        });
        source.addEventListener('log', function (e) {
          appendLog(parse(e.data));
        });
        source.addEventListener('status', function (e) {
          if (!done) taskStatus(parse(e.data) || 'streaming');
        });
        source.addEventListener('complete', function () {
          done = true;
          taskStatus('completed');
          source.close();
        });
        source.addEventListener('error', function (e) {
          // The server's named 'error' frame is a MessageEvent carrying .data;
          // a bare connection drop is a plain Event with none. Only the former
          // is a terminal task failure — the latter lets EventSource retry.
          if (e && typeof e.data === 'string') {
            done = true;
            appendLog(parse(e.data));
            taskStatus('failed');
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
// Read only status and launch metadata; never materialize prompt or log here.
taskLogViewRouter.get('/:id/log/view', (req, res) => {
  const meta = db.prepare('SELECT status, repo, branch, provider, model, auto_commit FROM tasks WHERE id = ?')
    .get(req.params.id) as LaunchMeta | undefined
  if (!meta) {
    res.status(404).json({ error: 'task not found' })
    return
  }
  res.type('html').send(viewHtml(req.params.id, meta))
})
