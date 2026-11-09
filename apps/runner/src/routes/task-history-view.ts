import { Router } from 'express'

export const taskHistoryViewRouter = Router()

// Read-only shell: all history selection and pagination stays in GET /tasks.
taskHistoryViewRouter.get('/history', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Forge task history</title>
<style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:.6rem;border-bottom:1px solid #aaa;overflow-wrap:anywhere}input,select,button{font:inherit;margin:.3rem}td:nth-child(4){white-space:pre-wrap}button:disabled{opacity:.5}</style>
</head><body><nav><a href="/dashboard">Dashboard</a> · <a href="/">Home</a></nav>
<h1>Task history</h1>
<form id="filters"><label>Repository (exact path) <input id="repo" type="text"></label>
<label>Status <select id="status"><option value="">All</option><option>queued</option><option>running</option><option>completed</option><option>failed</option></select></label>
<button type="submit">Apply filters</button></form>
<p id="message" role="status" aria-live="polite"></p>
<table><thead><tr><th>Outcome</th><th>Created</th><th>Repository</th><th>Prompt preview</th><th>Logs</th></tr></thead><tbody id="rows"></tbody></table>
<button id="older" disabled>Older</button><button id="retry" hidden>Retry request</button>
<script>
const repo = document.getElementById('repo');
const status = document.getElementById('status');
const rows = document.getElementById('rows');
const message = document.getElementById('message');
const older = document.getElementById('older');
const retry = document.getElementById('retry');
let generation = 0;
let next = null;
let selection = { repo: '', status: '' };
let failedBefore = null;
async function load(before) {
  const current = ++generation;
  const query = new URLSearchParams({ limit: '25' });
  if (selection.repo) query.set('repo', selection.repo);
  if (selection.status) query.set('status', selection.status);
  if (before) query.set('before', before);
  older.disabled = true;
  retry.hidden = true;
  rows.replaceChildren();
  message.textContent = 'Loading task history…';
  try {
    const response = await fetch('/tasks?' + query);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const tasks = await response.json();
    if (current !== generation) return;
    if (!Array.isArray(tasks)) throw new Error('Invalid response');
    next = response.headers.get('X-Next-Before');
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
      const cell = document.createElement('td');
      const link = document.createElement('a');
      link.href = '/tasks/' + encodeURIComponent(task.id) + '/log/view';
      link.textContent = 'View logs';
      cell.appendChild(link);
      row.appendChild(cell);
      rows.appendChild(row);
    }
    message.textContent = tasks.length ? 'Showing ' + tasks.length + ' tasks' : 'No tasks found.';
    older.disabled = !next;
  } catch (error) {
    if (current !== generation) return;
    failedBefore = before;
    message.textContent = 'Request failed: ' + error.message;
    retry.hidden = false;
  }
}
function reset() {
  selection = { repo: repo.value, status: status.value };
  next = null;
  return load(null);
}
document.getElementById('filters').onsubmit = event => { event.preventDefault(); return reset(); };
repo.onchange = reset;
status.onchange = reset;
older.onclick = () => { if (next && !older.disabled) return load(next); };
retry.onclick = () => load(failedBefore);
load(null);
</script></body></html>`)
})
