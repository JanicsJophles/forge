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
<form id="filters"><label>Repository (exact path) <input id="repo" type="text" list="repo-suggestions" aria-describedby="repo-discovery"></label>
<datalist id="repo-suggestions"></datalist>
<span id="repo-discovery" role="status" aria-live="polite">Optional suggestions load when the repository field is focused; any exact path is accepted.</span>
<label>Provider <select id="provider"><option value="">All</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
<label>Status <select id="status"><option value="">All</option><option>queued</option><option>running</option><option>completed</option><option>failed</option></select></label>
<button type="submit">Apply filters</button></form>
<p id="message" role="status" aria-live="polite"></p>
<div class="table-region" role="region" aria-label="Task history table" tabindex="0">
<table><caption id="displayed">No task history loaded.</caption><thead><tr><th>Outcome</th><th>Created</th><th>Repository</th><th>Prompt preview</th><th>Logs</th><th>Recorded commit</th><th>Changes</th><th>Run duration</th><th>Completed (UTC)</th><th>Launch settings</th><th>Task ID</th></tr></thead><tbody id="rows"></tbody></table>
</div>
<div class="paging" role="group" aria-label="History pages">
<p id="expired" role="status" hidden></p><button id="recover" hidden>Return to latest</button>
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
// Discovery is optional and attempted only once, when the field is used.
let discoveryStarted = false;
repo.onfocus = async () => {
  if (discoveryStarted) return;
  discoveryStarted = true;
  const feedback = document.getElementById('repo-discovery');
  feedback.textContent = 'Loading repository suggestions…';
  const controller = new AbortController();
  let timer;
  try {
    const entries = await Promise.race([
      (async () => {
        const response = await fetch('/repos', { signal: controller.signal });
        if (!response.ok) throw new Error('Unavailable');
        return response.json();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new Error('Timeout')); controller.abort(); }, 5000);
      }),
    ]);
    if (!Array.isArray(entries) || entries.length > 1000 || !entries.every(entry =>
      entry && typeof entry === 'object' && typeof entry.path === 'string' &&
      entry.path.startsWith('/') && entry.path.length <= 4096 && !/[\\x00-\\x1f\\x7f]/.test(entry.path) &&
      typeof entry.name === 'string' && entry.name.trim() && entry.name.length <= 4096)) {
      throw new Error('Invalid repositories');
    }
    const options = [];
    const seen = new Set();
    for (const entry of entries) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      const option = document.createElement('option');
      option.value = entry.path;
      // Include the path even when names are duplicated; never interpret labels as HTML.
      option.label = entry.name + ' — ' + entry.path;
      options.push(option);
    }
    document.getElementById('repo-suggestions').replaceChildren(...options);
    feedback.textContent = options.length ? 'Choose a suggestion or enter any exact repository path.'
      : 'No repositories discovered; enter any exact repository path.';
  } catch {
    feedback.textContent = 'Repository suggestions unavailable; enter any exact repository path.';
  } finally {
    clearTimeout(timer);
  }
};
const status = document.getElementById('status');
const provider = document.getElementById('provider');
const rows = document.getElementById('rows');
const displayed = document.getElementById('displayed');
const message = document.getElementById('message');
const older = document.getElementById('older');
const retry = document.getElementById('retry');
const newer = document.getElementById('newer');
const latest = document.getElementById('latest');
const refresh = document.getElementById('refresh');
const expired = document.getElementById('expired');
const recover = document.getElementById('recover');
let expiredSelection = null;
let generation = 0;
let next = null;
const browser = typeof window === 'undefined' ? null : window;
function readSelection() {
  const params = new URLSearchParams(browser ? browser.location.search : '');
  const requestedStatus = params.get('status') || '';
  const valid = ['', 'queued', 'running', 'completed', 'failed'].includes(requestedStatus);
  const requestedProvider = params.get('provider') || '';
  const validProvider = params.getAll('provider').length <= 1 && ['', 'claude', 'codex'].includes(requestedProvider);
  return { repo: params.get('repo') || '', status: valid ? requestedStatus : '', invalidStatus: !valid,
    provider: validProvider ? requestedProvider : '', invalidProvider: !validProvider };
}
function populate(value) {
  repo.value = value.repo;
  status.value = value.status;
  provider.value = value.provider;
}
let selection = readSelection();
populate(selection);
const initialBefore = browser ? new URLSearchParams(browser.location.search).get('before') : null;
let cursors = initialBefore ? [null, initialBefore] : [null];
let failedCursors = cursors;
let loading = false;
let successfulPage = null;
let failedSelection = selection;
let cancelRequest = null;
// Keep the original identity: encode once, without trimming or decoding percent escapes.
function safeTaskId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 200 || /^\\.+$/.test(id)) return false;
  try { encodeURIComponent(id); return true; } catch { return false; }
}
// Validate the whole requested page before rendering or committing navigation.
function validHistoryPage(tasks) {
  if (!Array.isArray(tasks) || tasks.length > 25) return false;
  return tasks.every(task => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return false;
    if (!safeTaskId(task.id)) return false;
    if (!['queued', 'running', 'completed', 'failed'].includes(task.status)) return false;
    for (const key of ['createdAt', 'startedAt', 'completedAt', 'repo', 'branch', 'prompt',
      'errorMessage', 'commitSha', 'provider', 'model']) {
      if (task[key] != null && typeof task[key] !== 'string') return false;
    }
    for (const key of ['promptTruncated', 'autoCommit']) {
      if (task[key] != null && typeof task[key] !== 'boolean') return false;
    }
    return true;
  });
}
function describe(pageCursors, pageSelection) {
  return 'Repository: ' + (pageSelection.repo || 'All repositories') +
    '; Status: ' + (pageSelection.status || 'All statuses') + '; Page ' + pageCursors.length +
    (pageCursors[pageCursors.length - 1] ? ' (before ' + pageCursors[pageCursors.length - 1] + ')' : ' (latest)') +
    '; Provider: ' + (pageSelection.provider || 'All providers');
}
function updateControls() {
  refresh.disabled = loading;
  recover.disabled = loading;
  older.disabled = loading || !!expiredSelection || !next;
  newer.disabled = latest.disabled = loading || !!expiredSelection || cursors.length === 1;
}
async function load(targetCursors, targetSelection = selection) {
  if (cancelRequest) cancelRequest();
  const before = targetCursors[targetCursors.length - 1];
  const current = ++generation;
  const query = new URLSearchParams({ limit: '25' });
  if (targetSelection.repo) query.set('repo', targetSelection.repo);
  if (targetSelection.status) query.set('status', targetSelection.status);
  if (targetSelection.provider) query.set('provider', targetSelection.provider);
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
        if (!response.ok) {
          const error = new Error('HTTP ' + response.status);
          error.expiredCursor = response.status === 404 && !!before;
          throw error;
        }
        return { response, tasks: await response.json() };
      })(),
      deadline,
    ]);
    if (current !== generation) return;
    if (!validHistoryPage(tasks)) throw new Error('Invalid history response. ' + (successfulPage
      ? 'Stale: showing the last successful page.' : 'Task history unavailable.'));
    const readTime = Date.now();
    const pageRows = [];
    for (const task of tasks) {
      const row = document.createElement('tr');
      const prompt = String(task.prompt || '');
      const promptPoints = Array.from(prompt);
      const preview = promptPoints.slice(0, 240).join('');
      for (const value of [task.status, task.createdAt, task.repo,
        preview + (task.promptTruncated || promptPoints.length > 240 ? '… [truncated]' : '')]) {
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
      const taskId = task.id;
      const taskPath = '/tasks/' + encodeURIComponent(taskId);
      if (taskId) {
        const link = document.createElement('a');
        link.href = taskPath + '/log/view';
        link.textContent = 'View logs';
        cell.appendChild(link);
      }
      row.appendChild(cell);
      const commit = document.createElement('td');
      commit.textContent = typeof task.commitSha === 'string' ? task.commitSha.slice(0, 7) : '';
      row.appendChild(commit);
      const changes = document.createElement('td');
      if (taskId) {
        const link = document.createElement('a');
        link.href = taskPath + '/changes/view';
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
        detail.href = taskPath;
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
    expiredSelection = null;
    expired.hidden = recover.hidden = true;
    next = response.headers.get('X-Next-Before');
    cursors = targetCursors;
    selection = targetSelection;
    successfulPage = { cursors, selection, next };
    displayed.textContent = describe(cursors, selection);
    message.textContent = (tasks.length ? 'Showing ' + tasks.length + ' tasks' : 'No tasks found.') +
      (targetSelection.invalidStatus ? ' Invalid URL status ignored; showing all statuses.' : '') +
      (targetSelection.invalidProvider ? ' Invalid URL provider ignored; showing all providers.' : '');
  } catch (error) {
    if (current !== generation) return;
    failedCursors = targetCursors;
    failedSelection = targetSelection;
    message.textContent = 'Request failed: ' + error.message + ' Requested ' + describe(targetCursors, targetSelection) +
      (successfulPage ? '. Rows still show previous filters/page; see displayed selection.' : '. No task history loaded.');
    displayed.textContent = successfulPage
      ? 'Stale — showing last successful selection. ' + describe(successfulPage.cursors, successfulPage.selection)
      : 'No task history loaded.';
    if (error.expiredCursor) expiredSelection = successfulPage ? successfulPage.selection : targetSelection;
    if (expiredSelection) {
      expired.hidden = recover.hidden = false;
      expired.textContent = 'This history page has expired because its pagination anchor is no longer retained.' +
        (successfulPage ? ' Stale rows: showing the last successful page until replacement succeeds.' : ' No task history loaded.') +
        ' Return to latest keeps repository ' + (expiredSelection.repo || 'All repositories') +
        ' and status ' + (expiredSelection.status || 'All statuses') +
        ' and provider ' + (expiredSelection.provider || 'All providers') + '.';
    }
    retry.hidden = !!expiredSelection;
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
  const target = { repo: repo.value, status: status.value, provider: provider.value };
  if (browser) {
    const params = new URLSearchParams();
    if (target.repo) params.set('repo', target.repo);
    if (target.status) params.set('status', target.status);
    if (target.provider) params.set('provider', target.provider);
    const url = browser.location.pathname + (params.size ? '?' + params : '') + browser.location.hash;
    if (url !== browser.location.pathname + browser.location.search + browser.location.hash) browser.history.pushState(null, '', url);
  }
  return load([null], target);
}
document.getElementById('filters').onsubmit = event => { event.preventDefault(); return reset(); };
repo.onchange = reset;
status.onchange = reset;
provider.onchange = reset;
older.onclick = () => { if (!older.disabled) return load([...cursors, next]); };
newer.onclick = () => { if (!newer.disabled) return load(cursors.slice(0, -1)); };
latest.onclick = () => { if (!latest.disabled) return load([null]); };
recover.onclick = () => { if (!recover.disabled && expiredSelection) return load([null], expiredSelection); };
retry.onclick = () => expiredSelection ? recover.onclick() : load(failedCursors, failedSelection);
refresh.onclick = () => {
  if (refresh.disabled) return;
  if (expiredSelection) return recover.onclick();
  return successfulPage ? load(successfulPage.cursors, successfulPage.selection) : load(cursors);
};
if (browser) browser.addEventListener('popstate', () => {
  const target = readSelection();
  populate(target);
  const before = new URLSearchParams(browser.location.search).get('before');
  return load(before ? [null, before] : [null], target);
});
load(cursors);
</script></body></html>`)
})
