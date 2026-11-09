import { Router } from 'express'

export const taskHistoryViewRouter = Router()

// Read-only shell: all history selection and pagination stays in GET /tasks.
taskHistoryViewRouter.get('/history', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Forge task history</title>
<style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.6rem;border-bottom:1px solid #aaa;overflow-wrap:anywhere}input,select,button{font:inherit;margin:.3rem}td:nth-child(4){white-space:pre-wrap}.failure-reason{white-space:pre-wrap}button:disabled{opacity:.5}</style>
</head><body><nav><a href="/dashboard">Dashboard</a> · <a href="/">Home</a></nav>
<h1>Task history</h1>
<form id="filters"><label>Repository (exact path) <input id="repo" type="text"></label>
<label>Status <select id="status"><option value="">All</option><option>queued</option><option>running</option><option>completed</option><option>failed</option></select></label>
<button type="submit">Apply filters</button></form>
<p id="message" role="status" aria-live="polite"></p>
<table><thead><tr><th>Outcome</th><th>Created</th><th>Repository</th><th>Prompt preview</th><th>Logs</th><th>Recorded commit</th><th>Changes</th></tr></thead><tbody id="rows"></tbody></table>
<button id="newer" disabled>Newer</button><button id="latest" disabled>Latest</button><button id="older" disabled>Older</button><button id="retry" hidden>Retry request</button>
<script>
const repo = document.getElementById('repo');
const status = document.getElementById('status');
const rows = document.getElementById('rows');
const message = document.getElementById('message');
const older = document.getElementById('older');
const retry = document.getElementById('retry');
const newer = document.getElementById('newer');
const latest = document.getElementById('latest');
let generation = 0;
let next = null;
let selection = { repo: '', status: '' };
let cursors = [null];
let failedCursors = cursors;
let loading = false;
function updateControls() {
  older.disabled = loading || !next;
  newer.disabled = latest.disabled = loading || cursors.length === 1;
}
async function load(targetCursors) {
  const before = targetCursors[targetCursors.length - 1];
  const current = ++generation;
  const query = new URLSearchParams({ limit: '25' });
  if (selection.repo) query.set('repo', selection.repo);
  if (selection.status) query.set('status', selection.status);
  if (before) query.set('before', before);
  loading = true;
  updateControls();
  retry.hidden = true;
  message.textContent = 'Loading task history…';
  try {
    const response = await fetch('/tasks?' + query);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const tasks = await response.json();
    if (current !== generation) return;
    if (!Array.isArray(tasks)) throw new Error('Invalid response');
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
      if (task.status === 'failed' && typeof task.errorMessage === 'string' && task.errorMessage) {
        const reason = document.createElement('div');
        reason.className = 'failure-reason';
        reason.textContent = task.errorMessage;
        row.children[0].appendChild(reason);
      }
      const cell = document.createElement('td');
      const link = document.createElement('a');
      link.href = '/tasks/' + encodeURIComponent(task.id) + '/log/view';
      link.textContent = 'View logs';
      cell.appendChild(link);
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
      pageRows.push(row);
    }
    rows.replaceChildren(...pageRows);
    next = response.headers.get('X-Next-Before');
    cursors = targetCursors;
    message.textContent = tasks.length ? 'Showing ' + tasks.length + ' tasks' : 'No tasks found.';
  } catch (error) {
    if (current !== generation) return;
    failedCursors = targetCursors;
    message.textContent = 'Request failed: ' + error.message;
    retry.hidden = false;
  } finally {
    if (current === generation) {
      loading = false;
      updateControls();
    }
  }
}
function reset() {
  selection = { repo: repo.value, status: status.value };
  next = null;
  cursors = [null];
  return load(cursors);
}
document.getElementById('filters').onsubmit = event => { event.preventDefault(); return reset(); };
repo.onchange = reset;
status.onchange = reset;
older.onclick = () => { if (!older.disabled) return load([...cursors, next]); };
newer.onclick = () => { if (!newer.disabled) return load(cursors.slice(0, -1)); };
latest.onclick = () => { if (!latest.disabled) return load([null]); };
retry.onclick = () => load(failedCursors);
load(cursors);
</script></body></html>`)
})
