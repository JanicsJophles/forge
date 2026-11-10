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

// This recovery page is deliberately static: missing tasks have no stream or
// transcript to load, and navigation should work without JavaScript.
function missingViewHtml(id: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>forge · task not found</title>
    <style>
      body { margin: 2rem auto; padding: 0 1rem; max-width: 48rem;
        background: #030712; color: #e4e4e7; font-family: system-ui, sans-serif; }
      a { color: #10b981; }
      code { overflow-wrap: anywhere; }
      nav { display: flex; gap: 1rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Task not found</h1>
      <p>No saved task was found for <code>${escapeHtml(id)}</code>.</p>
      <p>The task may have been pruned, or the bookmarked ID may be incorrect.</p>
      <nav aria-label="Recovery navigation">
        <a href="/history">History</a>
        <a href="/dashboard">Dashboard</a>
      </nav>
    </main>
  </body>
</html>`
}

interface LaunchMeta {
  prompt_prefix: Buffer | null
  prompt_bytes: number | null
  status: string | null
  repo: string | null
  branch: string | null
  provider: string | null
  model: string | null
  auto_commit: number | null
}

const MAX_PROMPT_BYTES = 16 * 1024

function viewHtml(id: string, meta: LaunchMeta): string {
  // Streaming decode drops an incomplete final UTF-8 sequence at the byte cap.
  const prompt = new TextDecoder().decode(meta.prompt_prefix ?? new Uint8Array(), { stream: true })
  const promptTruncated = (meta.prompt_bytes ?? 0) > MAX_PROMPT_BYTES
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
      .saved-prompt { flex-basis: 100%; min-width: 0; }
      .saved-prompt summary { cursor: pointer; }
      .saved-prompt pre { max-height: 30vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
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
      <button type="button" id="reconnect" hidden>Reconnect stream</button>
      <span id="actionMessage" role="status" aria-live="polite"></span>
      <div class="spacer"></div>
      <a href="${rawHref}">raw text</a>
      <a href="${downloadHref}">download</a>
      <a href="/dashboard">dashboard</a>
      <details class="configuration"><summary>Launch configuration</summary><dl>${configuration}</dl></details>
      <details class="saved-prompt"><summary>Saved prompt</summary><pre>
${escapeHtml(prompt || 'No saved prompt available.')}</pre>${promptTruncated ? `<p>Additional prompt content omitted (preview limited to ${MAX_PROMPT_BYTES} UTF-8 bytes). <a href="${escapeHtml(`/tasks/${encodedId}?view=detail`)}">Full task detail JSON</a></p>` : ''}</details>
    </header>
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
        var reconnectEl = document.getElementById('reconnect');
        var tokenEl = document.getElementById('authToken');
        var messageEl = document.getElementById('actionMessage');
        var taskUrl = STREAM_URL.slice(0, -'/stream'.length);
        // 128K UTF-16 code units = at most 256 KiB of retained text.
        // A single text node also bounds DOM size for tiny SSE frames.
        var MAX_LOG_UNITS = 128 * 1024;
        var transcript = null;
        var omittedEl = document.getElementById('omitted');
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
          var pinned = atBottom();
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
        function connect() {
          if (done) return;
          var previous = source;
          source = null;
          if (previous) previous.close();
          reconnectEl.hidden = true;
          setStatus('connecting…', '');
          var current;
          try {
            current = new EventSource(STREAM_URL);
            source = current;
          } catch (e) {
            setStatus('unavailable', 'fail');
            reconnectEl.hidden = false;
            return;
          }
          current.addEventListener('open', function () {
            if (done || source !== current) return;
            reconnectEl.hidden = true;
            if (opened) {
              // Each connection starts with a fresh server tail, not a resume.
              // Clear text in place so a retained transcript node (DOM cap) stays valid.
              Array.from(logEl.childNodes).forEach(function (node, index) {
                if (index === 0) node.textContent = '';
                else node.remove();
              });
              document.getElementById('replayNotice').hidden = false;
              var omitted = document.getElementById('omitted');
              if (omitted) omitted.hidden = true;
            }
            opened = true;
            setStatus('streaming', '');
          });
          current.addEventListener('log', function (e) {
            if (done || source !== current) return;
            appendLog(parse(e.data));
          });
          current.addEventListener('status', function (e) {
            if (!done && source === current) taskStatus(parse(e.data) || 'streaming');
          });
          current.addEventListener('complete', function () {
            if (done || source !== current) return;
            done = true;
            reconnectEl.hidden = true;
            taskStatus('completed');
            current.close();
          });
          current.addEventListener('error', function (e) {
            if (done || source !== current) return;
            // The server's named 'error' frame is a MessageEvent carrying .data;
            // a bare connection drop is a plain Event with none. Only the former
            // is a terminal task failure — the latter lets EventSource retry.
            if (e && typeof e.data === 'string') {
              done = true;
              appendLog(parse(e.data));
              taskStatus('failed');
              reconnectEl.hidden = true;
              current.close();
            } else if (!done) {
              setStatus('reconnecting…', 'warn');
              reconnectEl.hidden = false;
            }
          });
        }
        reconnectEl.onclick = connect;
        connect();
      })();
    </script>
  </body>
</html>
`
}

// GET /tasks/:id/log/view — a distinct path segment from /:id/log, so it never
// shadows (nor is shadowed by) the byte-slice log route. Only this human-facing
// route returns an HTML recovery page for a missing task.
// Bound the prompt in SQLite before crossing into JS; never materialize the log.
taskLogViewRouter.get('/:id/log/view', (req, res) => {
  const meta = db.prepare(`SELECT status, repo, branch, provider, model, auto_commit,
    substr(CAST(prompt AS BLOB), 1, ${MAX_PROMPT_BYTES}) AS prompt_prefix,
    length(CAST(prompt AS BLOB)) AS prompt_bytes FROM tasks WHERE id = ?`)
    .get(req.params.id) as LaunchMeta | undefined
  if (!meta) {
    res.status(404).type('html').send(missingViewHtml(req.params.id))
    return
  }
  res.type('html').send(viewHtml(req.params.id, meta))
})
