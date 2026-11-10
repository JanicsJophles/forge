import { Router } from 'express'

export const taskHistoryViewRouter = Router()

// Read-only shell: all history selection and pagination stays in GET /tasks.
taskHistoryViewRouter.get('/history', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Forge task history</title>
<style>
*{box-sizing:border-box}
body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem;overflow-wrap:anywhere}
form,.paging{display:flex;flex-wrap:wrap;align-items:end;gap:.6rem;max-width:100%;min-width:0}
label{display:flex;flex-direction:column;min-width:0;max-width:100%}
input,select,button{font:inherit;max-width:100%;min-width:0}
input,select{width:100%}
button{white-space:normal}
.table-region{max-width:100%;overflow-x:auto;margin:1rem 0}
.table-region:focus-visible{outline:2px solid currentColor;outline-offset:2px}
table{width:100%;min-width:70rem;table-layout:fixed;border-collapse:collapse}
td,th{text-align:left;padding:.6rem;border-bottom:1px solid #aaa;overflow-wrap:anywhere}
td:nth-child(4){white-space:pre-wrap}
.failure-reason{white-space:pre-wrap}
button:disabled{opacity:.5}
</style>
</head><body><nav><a href="/dashboard">Dashboard</a> · <a href="/">Home</a></nav>
<h1>Task history</h1>
<form id="filters"><label>Repository (exact path) <input id="repo" type="text"></label>
<label>Status <select id="status"><option value="">All</option><option>queued</option><option>running</option><option>completed</option><option>failed</option></select></label>
<button type="submit">Apply filters</button></form>
<p id="message" role="status" aria-live="polite"></p>
<div class="table-region" role="region" aria-label="Task history table" tabindex="0">
<table><caption id="displayed">No task history loaded.</caption><thead><tr><th>Outcome</th><th>Created</th><th>Repository</th><th>Prompt preview</th><th>Logs</th><th>Recorded commit</th><th>Changes</th><th>Run duration</th><th>Completed (UTC)</th><th>Launch settings</th><th>Task ID</th></tr></thead><tbody id="rows"></tbody></table>
</div>
<div class="paging" role="group" aria-label="History pages">
<button id="refresh">Refresh</button><button id="newer" disabled>Newer</button><button id="latest" disabled>Latest</button><button id="older" disabled>Older</button><button id="retry" hidden>Retry request</button>
</div>
<script>
// SQLite stores UTC without a zone; require a zone for ISO timestamps.
function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  const sqlite = /^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$/.test(value);
  const normalized = sqlite ? value.replace(' ', 'T') + 'Z' : value;
  if (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$/.test(normalized)) return null;
  if (Number(normalized.slice(11, 13)) > 23 || Number(normalized.slice(14, 16)) > 59 || Number(normalized.slice(17, 19)) > 59) return null;
  // Date.parse normalizes impossible calendar dates such as February 30.
  const calendar = new Date(normalized.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== normalized.slice(0, 10)) return null;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : null;
}
function durationText(task, readTime) {
  if (task.status === 'queued') return 'Unknown';
  const active = task.status === 'running';
  if (!active && task.status !== 'completed' && task.status !== 'failed') return 'Unknown';
  const start = parseTimestamp(task.startedAt);
  const end = active ? readTime : parseTimestamp(task.completedAt);
  if (start === null || end === null) return active ? 'Running · unknown elapsed' : 'Unknown';
  const seconds = Math.floor(Math.max(0, end - start) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const elapsed = hours ? hours + 'h ' + minutes + 'm ' + seconds % 60 + 's'
    : minutes ? minutes + 'm ' + seconds % 60 + 's' : seconds + 's';
  return active ? 'Running · ' + elapsed + ' elapsed' : elapsed;
}
function completionText(task) {
  if (task.status !== 'completed' && task.status !== 'failed') return 'Unknown';
  const time = parseTimestamp(task.completedAt);
  return time === null ? 'Unknown' : new Date(time).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC');
}
const repo = document.getElementById('repo');
const status = document.getElementById('status');
const rows = document.getElementById('rows');
const displayed = document.getElementById('displayed');
const message = document.getElementById('message');
const older = document.getElementById('older');
const retry = document.getElementById('retry');
const newer = document.getElementById('newer');
const latest = document.getElementById('latest');
const refresh = document.getElementById('refresh');
let generation = 0;
let next = null;
let selection = { repo: '', status: '' };
let cursors = [null];
let failedCursors = cursors;
let loading = false;
let successfulPage = null;
let failedSelection = selection;
let cancelRequest = null;
function describe(pageCursors, pageSelection) {
  return 'Repository: ' + (pageSelection.repo || 'All repositories') +
    '; Status: ' + (pageSelection.status || 'All statuses') + '; Page ' + pageCursors.length +
    (pageCursors[pageCursors.length - 1] ? ' (before ' + pageCursors[pageCursors.length - 1] + ')' : ' (latest)');
}
function updateControls() {
  refresh.disabled = loading;
  older.disabled = loading || !next;
  newer.disabled = latest.disabled = loading || cursors.length === 1;
}
async function load(targetCursors, targetSelection = selection) {
  if (cancelRequest) cancelRequest();
  const before = targetCursors[targetCursors.length - 1];
  const current = ++generation;
  const query = new URLSearchParams({ limit: '25' });
  if (targetSelection.repo) query.set('repo', targetSelection.repo);
  if (targetSelection.status) query.set('status', targetSelection.status);
  if (before) query.set('before', before);
  loading = true;
  updateControls();
  retry.hidden = true;
  message.textContent = 'Loading task history…';
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    cancelRequest = () => {
      clearTimeout(timer);
      reject(new Error('Request superseded'));
      controller.abort();
    };
    timer = setTimeout(() => {
      reject(new Error('Request timed out. Please retry.'));
      controller.abort();
    }, 15000);
  });
  try {
    // Race the entire read: abort alone cannot bound an uncooperative body reader.
    const { response, tasks } = await Promise.race([
      (async () => {
        const response = await fetch('/tasks?' + query, { signal: controller.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return { response, tasks: await response.json() };
      })(),
      deadline,
    ]);
    if (current !== generation) return;
    if (!Array.isArray(tasks)) throw new Error('Invalid response');
    const readTime = Date.now();
    const pageRows = [];
    for (const task of tasks) {
      const row = document.createElement('tr');
      const prompt = String(task.prompt || '');
      const preview = prompt.slice(0, 240);
      for (const value of [task.status, task.createdAt, task.repo,
        preview + (task.promptTruncated || prompt.length > 240 ? '… [truncated]' : '')]) {
        const cell = document.createElement('td');
        cell.textContent = value == null ? '' : String(value);
        row.appendChild(cell);
      }
      const branch = document.createElement('div');
      branch.textContent = 'Branch: ' + (typeof task.branch === 'string' && task.branch.trim() ? task.branch : 'unspecified');
      row.children[2].appendChild(branch);
      if (task.status === 'failed' && typeof task.errorMessage === 'string' && task.errorMessage) {
        const reason = document.createElement('div');
        reason.className = 'failure-reason';
        reason.textContent = task.errorMessage;
        row.children[0].appendChild(reason);
      }
      const cell = document.createElement('td');
      const taskId = typeof task.id === 'string' ? task.id : '';
      if (taskId) {
        const link = document.createElement('a');
        link.href = '/tasks/' + encodeURIComponent(taskId) + '/log/view';
        link.textContent = 'View logs';
        cell.appendChild(link);
      }
      row.appendChild(cell);
      const commit = document.createElement('td');
      commit.textContent = typeof task.commitSha === 'string' ? task.commitSha.slice(0, 7) : '';
      row.appendChild(commit);
      const changes = document.createElement('td');
      if (typeof task.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(task.id)) {
        const link = document.createElement('a');
        link.href = '/tasks/' + encodeURIComponent(task.id) + '/changes/view';
        link.textContent = 'Changes';
        changes.appendChild(link);
      }
      row.appendChild(changes);
      for (const value of [durationText(task, readTime), completionText(task)]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      }
      const settings = document.createElement('td');
      settings.textContent = [
        'Provider: ' + (task.provider || 'unspecified'),
        'Model: ' + (task.model || 'provider default'),
        'Auto-commit: ' + (task.autoCommit === true ? 'on' : task.autoCommit === false ? 'off' : 'unspecified'),
      ].join(' · ');
      row.appendChild(settings);
      const identity = document.createElement('td');
      const idText = document.createElement('code');
      idText.textContent = taskId || 'Unavailable';
      identity.appendChild(idText);
      if (taskId) {
        const detail = document.createElement('a');
        detail.href = '/tasks/' + encodeURIComponent(taskId);
        detail.textContent = 'Task JSON';
        const space = document.createElement('span');
        space.textContent = ' ';
        identity.appendChild(space);
        identity.appendChild(detail);
      }
      row.appendChild(identity);
      pageRows.push(row);
    }
    rows.replaceChildren(...pageRows);
    next = response.headers.get('X-Next-Before');
    cursors = targetCursors;
    selection = targetSelection;
    successfulPage = { cursors, selection };
    displayed.textContent = describe(cursors, selection);
    message.textContent = tasks.length ? 'Showing ' + tasks.length + ' tasks' : 'No tasks found.';
  } catch (error) {
    if (current !== generation) return;
    failedCursors = targetCursors;
    failedSelection = targetSelection;
    message.textContent = 'Request failed: ' + error.message + ' Requested ' + describe(targetCursors, targetSelection) +
      (successfulPage ? '. Rows still show previous filters/page; see displayed selection.' : '. No task history loaded.');
    displayed.textContent = successfulPage
      ? 'Stale — showing last successful selection. ' + describe(successfulPage.cursors, successfulPage.selection)
      : 'No task history loaded.';
    retry.hidden = false;
  } finally {
    clearTimeout(timer);
    if (current === generation) {
      cancelRequest = null;
      loading = false;
      updateControls();
    }
  }
}
function reset() {
  return load([null], { repo: repo.value, status: status.value });
}
document.getElementById('filters').onsubmit = event => { event.preventDefault(); return reset(); };
repo.onchange = reset;
status.onchange = reset;
older.onclick = () => { if (!older.disabled) return load([...cursors, next]); };
newer.onclick = () => { if (!newer.disabled) return load(cursors.slice(0, -1)); };
latest.onclick = () => { if (!latest.disabled) return load([null]); };
retry.onclick = () => load(failedCursors, failedSelection);
refresh.onclick = () => {
  if (refresh.disabled) return;
  return successfulPage ? load(successfulPage.cursors, successfulPage.selection) : load(cursors);
};
load(cursors);
</script></body></html>`)
})
