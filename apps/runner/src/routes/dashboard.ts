// ---------------------------------------------------------------------------
// /dashboard — live HTML view of the agent-board state.
//
// Pure HTML/CSS/vanilla-JS. Polls /agent-context every 5s. Dark theme
// matching the RackMind brand (#030712 background, #10b981 accent).
// One file, no framework, no auth — Tailscale-only access at port 5000.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response } from 'express'

export const dashboardRouter = Router()

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>forge · agent board</title>
  <style>
    :root {
      --bg: #030712;
      --panel: #0a0f1e;
      --panel-2: #0f1629;
      --border: #1a2238;
      --text: #e4e4e7;
      --text-dim: #71717a;
      --text-mute: #4a4a52;
      --accent: #10b981;
      --warn: #f59e0b;
      --fail: #ef4444;
      --running: #3b82f6;
      --merged: #8b5cf6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      min-height: 100vh;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, #0a0f1e 0%, #030712 100%);
    }
    h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: 0.02em; }
    h1 .dot {
      display: inline-block;
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--accent);
      margin-right: 8px;
      box-shadow: 0 0 8px var(--accent);
      animation: pulse 2s infinite;
    }
    h1 .dot.stale { background: var(--warn); box-shadow: none; animation: none; }
    #connection { color: var(--warn); }
    #connection.connected { color: var(--accent); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .meta { color: var(--text-dim); font-size: 12px; }
    .meta b { color: var(--text); font-weight: 600; }
    main {
      display: grid;
      grid-template-columns: 1fr 1.2fr;
      gap: 16px;
      padding: 16px 24px;
      max-width: 1600px;
      margin: 0 auto;
    }
    @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
    section {
      min-width: 0;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    section h2 {
      margin: 0;
      padding: 12px 16px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-dim);
      background: var(--panel-2);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    section h2 .count {
      background: var(--border);
      color: var(--text);
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
    }
    .empty {
      padding: 24px 16px;
      text-align: center;
      color: var(--text-mute);
      font-size: 12px;
    }
    .agent-row, .event-row, .task-row {
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      font-family: 'SF Mono', Menlo, monospace;
      font-size: 12px;
    }
    .agent-row:last-child, .event-row:last-child, .task-row:last-child { border-bottom: none; }
    .agent-row .id, .task-row .id { color: var(--accent); font-weight: 600; }
    .agent-row .repo, .task-row .repo {
      display: inline-block;
      background: var(--panel-2);
      color: var(--text-dim);
      padding: 1px 6px;
      border-radius: 4px;
      margin-left: 6px;
      font-size: 11px;
    }
    .agent-row .ticket {
      display: inline-block;
      color: var(--accent);
      margin-left: 6px;
      font-size: 11px;
    }
    .agent-row .status {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      margin-left: 6px;
    }
    .status-starting,
    .status-queued { background: rgba(245, 158, 11, 0.2); color: var(--warn); }
    .status-editing,
    .status-running,
    .status-testing,
    .status-pushing { background: rgba(59, 130, 246, 0.2); color: var(--running); }
    .status-done,
    .status-merging { background: rgba(16, 185, 129, 0.2); color: var(--accent); }
    .status-aborted,
    .status-failed { background: rgba(239, 68, 68, 0.2); color: var(--fail); }
    .agent-row .intent, .task-row .intent {
      display: block;
      margin-top: 4px;
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.4;
    }
    .agent-row .branch, .agent-row .claimed-files, .task-row .branch {
      margin-top: 4px;
      color: var(--text-dim);
      overflow-wrap: anywhere;
    }
    .agent-row .claimed-files summary { cursor: pointer; }
    .agent-row .claimed-files ul { margin: 6px 0 0; padding-left: 20px; }
    .agent-row .updated, .task-row .age {
      color: var(--text-mute);
      font-size: 11px;
      margin-top: 4px;
    }
    .task-row .elapsed {
      display: inline-block;
      margin-left: 6px;
      color: var(--running);
      font-size: 11px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .task-row .provider {
      display: inline-block;
      background: var(--panel-2);
      color: var(--text-dim);
      padding: 1px 6px;
      border-radius: 4px;
      margin-left: 6px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .task-row .log {
      display: inline-block;
      margin-left: 6px;
      color: var(--running);
      text-decoration: none;
      font-size: 11px;
    }
    .task-row .log:hover { text-decoration: underline; }
    .task-row .changes {
      display: inline-block;
      margin-left: 6px;
      color: var(--running);
      text-decoration: none;
      font-size: 11px;
    }
    .task-row .changes:hover { text-decoration: underline; }
    .task-row .cancel {
      margin-left: 6px;
      background: rgba(239, 68, 68, 0.12);
      color: var(--fail);
      border: 1px solid rgba(239, 68, 68, 0.4);
      border-radius: 4px;
      padding: 1px 8px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
    }
    .task-row .cancel:hover:not(:disabled) { background: rgba(239, 68, 68, 0.2); }
    .task-row .cancel:disabled { opacity: 0.6; cursor: default; }
    .task-row.cancelling { opacity: 0.5; }
    .task-row .cancel-err {
      margin-left: 6px;
      color: var(--fail);
      font-size: 11px;
    }
    .task-row .retry {
      margin-left: 6px;
      background: rgba(16, 185, 129, 0.12);
      color: var(--accent);
      border: 1px solid rgba(16, 185, 129, 0.4);
      border-radius: 4px;
      padding: 1px 8px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
    }
    .task-row .retry:hover:not(:disabled) { background: rgba(16, 185, 129, 0.2); }
    .task-row .retry:disabled { opacity: 0.6; cursor: default; }
    .task-row .commit {
      display: inline-block;
      margin-left: 6px;
      color: var(--merged);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .task-row .error-message {
      display: block;
      margin-top: 4px;
      color: var(--fail);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .task-row .retry-msg { margin-left: 6px; font-size: 11px; }
    .task-row .retry-msg.ok { color: var(--accent); }
    .task-row .retry-msg.err { color: var(--fail); overflow-wrap: anywhere; }
    .full-span { grid-column: 1 / -1; }
    .event-row .time {
      display: inline-block;
      color: var(--text-mute);
      font-size: 11px;
      margin-right: 8px;
    }
    .event-row .type {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      margin-right: 6px;
    }
    .type-pr_opened, .type-promotion_opened { background: rgba(59, 130, 246, 0.2); color: var(--running); }
    .type-pr_merged, .type-promotion_merged, .type-ticket_done { background: rgba(16, 185, 129, 0.2); color: var(--accent); }
    .type-pr_ci_failed, .type-forge_failed, .type-agent_aborted { background: rgba(239, 68, 68, 0.2); color: var(--fail); }
    .type-agent_started, .type-forge_dispatched { background: rgba(139, 92, 246, 0.2); color: var(--merged); }
    .type-ticket_stale_detected { background: rgba(245, 158, 11, 0.2); color: var(--warn); }
    .event-row .repo { color: var(--text-dim); margin-right: 6px; font-size: 11px; }
    .event-row .ticket { color: var(--accent); margin-right: 6px; font-size: 11px; }
    .event-row .pr {
      color: var(--text);
      margin-right: 6px;
      font-size: 11px;
    }
    .event-row .pr a { color: var(--running); text-decoration: none; }
    .event-row .pr a:hover { text-decoration: underline; }
    .event-row .agent {
      color: var(--text-mute);
      font-size: 11px;
    }
    .event-row { overflow-wrap: anywhere; }
    .event-details { margin-top: 6px; min-width: 0; }
    .event-details summary { cursor: pointer; color: var(--text-dim); }
    .event-details summary:focus-visible { outline: 2px solid var(--accent); }
    .event-details pre { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; }
    .by-repo {
      padding: 12px 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      border-top: 1px solid var(--border);
      background: var(--panel-2);
    }
    #repoFilter, #activityFilter, #eventTypeFilter, #ticketFilter, #authToken { background: var(--panel); color: var(--text); border: 1px solid var(--border); padding: 4px 8px; }
    #authToken { min-width: 280px; font-family: 'SF Mono', Menlo, monospace; }
    .by-repo .pill {
      background: var(--panel);
      border: 1px solid var(--border);
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      color: var(--text-dim);
    }
    .by-repo .pill b { color: var(--accent); margin-right: 4px; }
    .launch-form {
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .launch-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .launch-row label { color: var(--text-dim); font-size: 12px; }
    .launch-form select,
    .launch-form input[type="text"],
    .launch-form textarea {
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 8px;
      font-size: 12px;
      font-family: inherit;
    }
    .launch-form #launchRepo { min-width: 160px; }
    .launch-form #launchModel { min-width: 140px; }
    .launch-form textarea {
      width: 100%;
      min-height: 64px;
      resize: vertical;
      font-family: 'SF Mono', Menlo, monospace;
      line-height: 1.4;
    }
    .launch-check { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
    .launch-actions { display: flex; align-items: center; gap: 10px; }
    .launch-form button {
      background: rgba(16, 185, 129, 0.14);
      color: var(--accent);
      border: 1px solid rgba(16, 185, 129, 0.4);
      border-radius: 4px;
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
    }
    .launch-form button:hover:not(:disabled) { background: rgba(16, 185, 129, 0.22); }
    .launch-form button:disabled { opacity: 0.6; cursor: default; }
    .launch-err { color: var(--fail); font-size: 11px; overflow-wrap: anywhere; }
    footer {
      padding: 12px 24px;
      color: var(--text-mute);
      font-size: 11px;
      text-align: center;
      border-top: 1px solid var(--border);
    }
    .err {
      padding: 16px;
      color: var(--fail);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <header>
    <h1><span class="dot stale" id="connectionDot"></span>forge · agent board</h1>
    <div class="meta">
      <span id="connection" role="status" aria-live="polite">Connecting · last success: never</span> &middot;
      <span id="generatedAt">—</span> &middot;
      <b id="liveCount">0</b> checkpoints shown &middot;
      <b id="eventCount">0</b> events shown (recent snapshot) &middot;
      <span id="capacity">—</span>
    </div>
  </header>

  <div class="by-repo" id="authTokenRow" style="display: none;">
    <label for="authToken">Auth token</label>
    <input type="password" id="authToken" placeholder="Bearer token — required for cancel / retry / launch" autocomplete="off" />
  </div>

  <div class="by-repo">
    <label for="repoFilter">Repository</label>
    <select id="repoFilter"><option value="">All repositories</option></select>
    <label for="activityFilter">Agent activity</label>
    <select id="activityFilter">
      <option value="all">All checkpoints</option>
      <option value="working">Working</option>
      <option value="finished">Finished</option>
    </select>
  </div>

  <div class="by-repo">
    <label for="eventTypeFilter">Event type</label>
    <select id="eventTypeFilter"><option value="">All event types</option></select>
    <label for="ticketFilter">Ticket (agents and events only)</label>
    <select id="ticketFilter"><option value="">All tickets</option></select>
  </div>

  <main>
    <section>
      <h2>Agent checkpoints (unexpired) <span class="count" id="liveCount2">0</span></h2>
      <div id="agents"></div>
      <div class="by-repo" id="byRepo"></div>
    </section>

    <section>
      <h2>Recent event snapshot <span class="count" id="eventCount2">0</span></h2>
      <p id="eventCoverage" role="status" aria-live="polite"></p>
      <div id="events"></div>
    </section>

    <section class="full-span">
      <h2>New task</h2>
      <form id="newTaskForm" class="launch-form">
        <div class="launch-row">
          <label for="launchRepo">Repository</label>
          <select id="launchRepo" aria-describedby="launchRepoState"><option value="">loading repositories…</option></select>
          <span id="launchRepoState" role="status" aria-live="polite" style="overflow-wrap:anywhere"></span>
          <label for="launchProvider">Provider</label>
          <select id="launchProvider">
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
          <label for="launchModel">Model (optional)</label>
          <input type="text" id="launchModel" placeholder="provider default" autocomplete="off" />
          <label class="launch-check"><input type="checkbox" id="launchAutoCommit" /> autoCommit</label>
        </div>
        <textarea id="launchPrompt" placeholder="Prompt — what should the agent do?"></textarea>
        <div class="launch-actions">
          <button type="submit" id="launchSubmit">Launch task</button>
          <span class="launch-err" id="launchErr" role="status" aria-live="polite"></span>
          <span id="launchSuccess" role="status" aria-live="polite"></span>
        </div>
      </form>
    </section>

    <section class="full-span">
      <h2>Runner tasks (own) <span class="count" id="taskCount2">0</span></h2>
      <div id="tasks"></div>
      <div class="by-repo" id="tasksByRepo"></div>
    </section>

    <section class="full-span">
      <h2>Recent tasks <span class="count" id="recentCount">0</span></h2>
      <div id="recentHealth" role="status">Recent tasks · last update: never</div>
      <div id="recentTasks"></div>
    </section>
  </main>

  <footer>
    Auto-refreshes every 5s. Source: <code>/agent-context</code> &middot; LXC 207 &middot; forge-runner
  </footer>

  <script>
    const GITHUB_ORG = __GITHUB_ORG__;
    // --- Bearer-token auth for state-changing controls -----------------------
    // When the runner is started with FORGE_AUTH_TOKEN, POST/DELETE routes answer
    // 401 without an Authorization header. The token input (revealed only when
    // /capabilities reports authRequired) feeds authHeaders(), which is spread
    // into the three state-changing fetches and NO read fetch. The token lives in
    // sessionStorage so a reload keeps the operator signed in for the tab only.
    const AUTH_TOKEN_KEY = 'forge.authToken';
    function readStoredToken() {
      try {
        return (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(AUTH_TOKEN_KEY)) || '';
      } catch (e) {
        return '';
      }
    }
    function persistToken(value) {
      try {
        if (typeof sessionStorage === 'undefined') return;
        if (value) sessionStorage.setItem(AUTH_TOKEN_KEY, value);
        else sessionStorage.removeItem(AUTH_TOKEN_KEY);
      } catch (e) {
        // Storage disabled (private mode / quota): the in-memory input still
        // works for the life of this tab; we just can't survive a reload.
      }
    }
    function authHeaders() {
      const input = document.getElementById('authToken');
      const token = input && input.value ? String(input.value).trim() : readStoredToken();
      return token ? { Authorization: 'Bearer ' + token } : {};
    }
    function wireAuthToken() {
      const input = document.getElementById('authToken');
      if (!input) return;
      input.value = readStoredToken();
      input.oninput = () => persistToken(String(input.value || '').trim());
    }
    async function revealAuthIfRequired() {
      // /capabilities is a read endpoint, never auth-gated. authRequired true means
      // the runner has a token configured, so reveal the input; otherwise it stays
      // hidden and authHeaders() stays a no-op.
      try {
        const r = await fetch('/capabilities');
        if (!r.ok) return;
        const c = await r.json();
        if (c && c.authRequired === true) {
          const row = document.getElementById('authTokenRow');
          if (row && row.style) row.style.display = '';
        }
      } catch (e) {
        // Unreachable capabilities: leave the input hidden (same as auth-off). The
        // launcher/cancel/retry controls still render and will surface a 401 inline.
      }
    }
    function escape(s) {
      const d = document.createElement('div');
      d.textContent = s == null ? '' : String(s);
      return d.innerHTML;
    }
    function relTime(iso) {
      if (typeof iso !== 'string' || !iso.trim()) return '—';
      let timestamp = iso.trim().replace(' ', 'T');
      // SQLite timestamps are UTC but omit the zone. Preserve explicit ISO zones.
      if (!/(Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(timestamp)) timestamp += 'Z';
      const t = Date.parse(timestamp);
      if (!Number.isFinite(t)) return '—';
      const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
      if (sec < 60) return sec + 's ago';
      if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
      if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
      return Math.floor(sec / 86400) + 'd ago';
    }
    function elapsed(iso) {
      // Compact running duration since createdAt, e.g. '12m 03s' / '1h 04m 09s'.
      // Returns '' for missing/malformed input so the caller can omit the label.
      if (typeof iso !== 'string' || !iso.trim()) return '';
      let timestamp = iso.trim().replace(' ', 'T');
      if (!/(Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(timestamp)) timestamp += 'Z';
      const t = Date.parse(timestamp);
      if (!Number.isFinite(t)) return '';
      const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
      const pad = n => String(n).padStart(2, '0');
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      return h > 0 ? h + 'h ' + pad(m) + 'm ' + pad(s) + 's' : m + 'm ' + pad(s) + 's';
    }
    const claimedFilesOpen = new Map();
    function renderAgents(agents) {
      const root = document.getElementById('agents');
      // Read the current DOM before replacing it, including toggles whose event is still queued.
      for (const details of root.querySelectorAll('details.claimed-files')) {
        claimedFilesOpen.set(details.dataset.agentId, details.open);
      }
      const liveIds = new Set(latestSnapshot.liveAgents.map(a => a.agentId));
      for (const id of claimedFilesOpen.keys()) {
        if (!liveIds.has(id)) claimedFilesOpen.delete(id);
      }
      if (!agents.length) {
        root.innerHTML = '<div class="empty">no matching agent checkpoints</div>';
        return;
      }
      root.innerHTML = agents.map(a => {
        const statusClass = a.status ? 'status-' + a.status.replace(/[^a-z]/g, '') : '';
        return [
          '<div class="agent-row">',
            '<div>',
              '<span class="id">' + escape(a.agentId) + '</span>',
              a.repo ? '<span class="repo">' + escape(a.repo) + '</span>' : '',
              a.ticket ? '<span class="ticket">' + escape(a.ticket) + '</span>' : '',
              a.status ? '<span class="status ' + statusClass + '">' + escape(a.status) + '</span>' : '',
            '</div>',
            a.branch ? '<div class="branch">branch: ' + escape(a.branch) + '</div>' : '',
            a.filesTouched && a.filesTouched.length ? '<details class="claimed-files" data-agent-id="' + escape(a.agentId) + '"' + (claimedFilesOpen.get(a.agentId) ? ' open' : '') + '><summary>Claimed files (' + a.filesTouched.length + ')</summary><ul>' +
              a.filesTouched.map(file => '<li>' + escape(file) + '</li>').join('') + '</ul></details>' : '',
            a.intent ? '<div class="intent">' + escape(a.intent) + '</div>' : '',
            '<div class="updated">updated ' + relTime(a.updatedAt) + '</div>',
          '</div>'
        ].join('');
      }).join('');
    }
    const openEventDetails = new Set();
    function rememberEventDetails(element) {
      // Ignore queued toggle events from nodes replaced by a poll/filter render.
      if (!element.isConnected) return;
      const id = element.dataset.eventId;
      if (element.open) openEventDetails.add(id);
      else openEventDetails.delete(id);
    }
    function pullRequestUrl(repo, number) {
      if (typeof repo !== 'string' || !Number.isSafeInteger(number) || number <= 0) return null;
      // Only an explicit owner/repo supplies an owner; absolute checkout paths use the fallback.
      const parts = repo.split('/');
      const owner = parts.length === 2 && parts[0] ? parts[0] : GITHUB_ORG;
      const name = parts[parts.length - 1];
      if (repo.startsWith('//') || (!repo.startsWith('/') && parts.length > 2)) return null;
      // Validate components before placing them in an HTML attribute or URL path.
      if (!/^[a-zA-Z0-9_-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') return null;
      return 'https://github.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/pull/' + number;
    }
    function renderEventCoverage(snapshot) {
      const coverage = snapshot.recentEventsTruncated;
      document.getElementById('eventCoverage').textContent = coverage === true
        ? 'Recent snapshot: older events are omitted. Filters search only the loaded snapshot.'
        : coverage === false
          ? 'Recent snapshot: no truncation for the returned window. Filters search only the loaded snapshot.'
          : 'Recent snapshot: coverage unknown. Filters search only the loaded snapshot.';
    }
    function renderEvents(events) {
      const root = document.getElementById('events');
      if (!events.length) {
        root.innerHTML = '<div class="empty">' + ((selectedRepo || selectedEventType || selectedTicket) ? 'no matching events in recent snapshot' : 'no events in recent snapshot') + '</div>';
        return;
      }
      root.innerHTML = events.map(e => {
        const typeClass = 'type-' + e.eventType.replace(/[^a-z_]/g, '');
        let prHtml = '';
        if (e.prNumber) {
          const url = pullRequestUrl(e.repo, e.prNumber);
          const label = 'PR#' + escape(e.prNumber);
          prHtml = '<span class="pr">' + (url ? '<a target="_blank" href="' + escape(url) + '">' + label + '</a>' : label) + '</span>';
        }
        return [
          '<div class="event-row">',
            '<span class="time">' + relTime(e.createdAt) + '</span>',
            '<span class="type ' + typeClass + '">' + escape(e.eventType) + '</span>',
            e.repo ? '<span class="repo">' + escape(e.repo) + '</span>' : '',
            e.ticket ? '<span class="ticket">' + escape(e.ticket) + '</span>' : '',
            prHtml,
            e.agentId ? '<span class="agent">by ' + escape(e.agentId.slice(0, 24)) + '</span>' : '',
            e.details && typeof e.details === 'object' && Object.keys(e.details).length
              ? '<details class="event-details"' +
                (Number.isSafeInteger(e.id) ? ' data-event-id="' + e.id + '" ontoggle="rememberEventDetails(this)"' : '') +
                (openEventDetails.has(String(e.id)) ? ' open' : '') +
                '><summary>Event details</summary><pre>' + escape(JSON.stringify(e.details, null, 2)) + '</pre></details>'
              : '',
          '</div>'
        ].join('');
      }).join('');
    }
    function renderByRepo(by, rootId) {
      const root = document.getElementById(rootId);
      const entries = Object.entries(by || {});
      if (!entries.length) { root.innerHTML = ''; return; }
      root.innerHTML = entries.map(([repo, n]) => '<span class="pill"><b>' + n + '</b>' + escape(repo) + '</span>').join('');
    }
    const cancellations = new Map();
    function cancelLabel(state) {
      return state && state.pending ? 'cancelling…' : state && state.success ? 'cancel requested' : 'cancel';
    }
    function paintCancellation(button, state) {
      button.disabled = !!(state.pending || state.success);
      button.textContent = cancelLabel(state);
      const row = button.closest ? button.closest('.task-row') : null;
      const previous = row ? row.querySelector('.cancel-err') : null;
      if (previous) previous.remove();
      if (state.message) {
        const error = document.createElement('span');
        error.className = 'cancel-err';
        error.textContent = state.message;
        button.insertAdjacentElement('afterend', error);
      }
    }
    async function cancelTask(button) {
      const encodedId = button.dataset.taskId;
      const previous = cancellations.get(encodedId);
      if (!encodedId || (previous && (previous.pending || previous.success))) return;
      if (!confirm('Cancel this runner task?')) return;
      const state = { pending: true, success: false, message: '' };
      cancellations.set(encodedId, state);
      paintCancellation(button, state);
      const headers = authHeaders();
      const token = (headers.Authorization || '').replace(/^Bearer /, '');
      function safeMessage(value) {
        const text = String(value);
        return (token ? text.split(token).join('[redacted]') : text).slice(0, 500);
      }
      const controller = new AbortController();
      let timer;
      try {
        // Keep all transport work free of UI mutations: even an abort-ignoring
        // fetch or JSON body can settle after the deadline or a newer attempt.
        const result = await Promise.race([
          (async () => {
            const response = await fetch('/tasks/' + encodedId, { method: 'DELETE', headers, signal: controller.signal });
            if (response.ok) return { success: true, message: '' };
            let body;
            try { body = await response.json(); } catch (_) { /* Fixed fallback below. */ }
            const detail = body && typeof body.error === 'string' && body.error.trim()
              ? body.error + (typeof body.reason === 'string' ? ': ' + body.reason : '')
              : 'server returned no usable JSON error; check runner logs';
            return { success: false, message: 'cancel rejected: HTTP ' + response.status + ': ' + safeMessage(detail) };
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('deadline'));
              controller.abort();
            }, 15000);
          }),
        ]);
        if (cancellations.get(encodedId) !== state) return;
        state.success = result.success;
        state.message = result.message;
      } catch (_) {
        if (cancellations.get(encodedId) !== state) return;
        state.message = 'Cancellation outcome unknown (timeout or connection lost). Check task status or logs before cancelling again; the request may have succeeded.';
      } finally {
        clearTimeout(timer);
        if (cancellations.get(encodedId) === state) {
          state.pending = false;
          // Polling may have replaced the original row while DELETE was pending.
          const buttons = document.getElementById('tasks').querySelectorAll('button.cancel');
          for (const current of buttons) {
            if (current.dataset.taskId === encodedId) paintCancellation(current, state);
          }
          if (button.isConnected !== false) paintCancellation(button, state);
        }
      }
    }
    let launchRepos = [];
    let launchReposStale = false;
    function renderLaunchRepoState() {
      const path = document.getElementById('launchRepo').value;
      const repo = launchRepos.find(repo => repo.path === path);
      const status = document.getElementById('launchRepoState');
      if (!repo) {
        status.textContent = path ? 'Repository state unknown.' : 'Select a repository to see checkout state.';
        return;
      }
      const branch = repo.branchError ? 'branch probe failed'
        : typeof repo.currentBranch === 'string' && repo.currentBranch ? 'branch: ' + repo.currentBranch : 'branch unknown';
      const dirty = repo.statusError ? 'status unknown (status probe failed)'
        : repo.dirty === true ? 'Warning: dirty checkout — uncommitted changes'
        : repo.dirty === false ? 'clean checkout' : 'status unknown';
      // Repository metadata is untrusted; never interpret it as markup.
      status.textContent = (launchReposStale ? 'Stale repository state (reload failed): ' : '')
        + repo.path + ' · ' + branch + ' · ' + dirty;
    }
    async function loadRepos() {
      // Populate the launcher's repo <select> from GET /repos, once on load.
      // A read endpoint, so it is never auth-gated. Option values are repo paths
      // (what POST /tasks expects); labels fall back to the path if name is blank.
      const select = document.getElementById('launchRepo');
      try {
        const r = await fetch('/repos');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const repos = await r.json();
        if (!Array.isArray(repos)) throw new Error('invalid repos');
        const options = repos
          .filter(repo => repo && typeof repo.path === 'string' && repo.path)
          .map(repo => {
            const label = typeof repo.name === 'string' && repo.name ? repo.name : repo.path;
            // escape() neutralizes a hostile repo name/path before it reaches the DOM.
            return '<option value="' + escape(repo.path).replace(/"/g, '&quot;') + '">' + escape(label) + '</option>';
          })
          .join('');
        const previous = select.value;
        select.innerHTML = options || '<option value="">no repositories available</option>';
        launchRepos = repos.filter(repo => repo && typeof repo.path === 'string' && repo.path);
        if (launchRepos.some(repo => repo.path === previous)) select.value = previous;
        launchReposStale = false;
        renderLaunchRepoState();
      } catch (e) {
        launchReposStale = true;
        if (!launchRepos.length) select.innerHTML = '<option value="">could not load repositories</option>';
        renderLaunchRepoState();
      }
    }
    async function submitNewTask(event) {
      if (event && event.preventDefault) event.preventDefault();
      const button = document.getElementById('launchSubmit');
      if (button.disabled) return;
      const errEl = document.getElementById('launchErr');
      const successEl = document.getElementById('launchSuccess');
      successEl.textContent = '';
      const authorization = authHeaders().Authorization || '';
      const token = authorization.replace(/^Bearer /, '');
      function safeMessage(value) {
        const text = String(value);
        return (token ? text.split(token).join('[redacted]') : text).slice(0, 500);
      }
      const repo = document.getElementById('launchRepo').value;
      const prompt = document.getElementById('launchPrompt').value;
      const provider = document.getElementById('launchProvider').value;
      const model = document.getElementById('launchModel').value.trim();
      const autoCommit = document.getElementById('launchAutoCommit').checked === true;
      // Clear any stale error from a previous attempt; textContent can't inject HTML.
      errEl.textContent = '';
      if (!repo) { errEl.textContent = 'select a repository'; return; }
      if (!prompt.trim()) { errEl.textContent = 'prompt is required'; return; }
      button.disabled = true;
      const original = button.textContent;
      button.textContent = 'launching…';
      const controller = new AbortController();
      let timer;
      let uncertain = true;
      try {
        // Only send model when the operator typed one; a blank field POSTs no
        // model so the server applies the provider default. An invalid value
        // comes back 400 and surfaces inline via the throw below.
        const body = { repo, prompt, provider, autoCommit };
        if (model) body.model = model;
        // Transport work must not mutate the UI after the deadline wins.
        const received = await Promise.race([
          (async () => {
            const r = await fetch('/tasks', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders() },
              body: JSON.stringify(body),
              signal: controller.signal,
            });
            let result;
            try { result = await r.json(); } catch (_) { /* Use a fixed fallback, never raw HTML. */ }
            return { r, result };
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('15-second deadline exceeded'));
              controller.abort();
            }, 15000);
          }),
        ]);
        const { r, result } = received;
        if (!r.ok) {
          uncertain = false;
          const detail = result && typeof result.error === 'string' && result.error.trim()
            ? result.error + (typeof result.reason === 'string' ? ': ' + result.reason : '')
            : 'server returned no usable JSON error; check runner logs';
          throw new Error('HTTP ' + r.status + ': ' + safeMessage(detail));
        }
        const taskId = result && result.taskId;
        if (r.status !== 201 || typeof taskId !== 'string' || !taskId.trim() ||
            taskId.length > 200 || (token && taskId.includes(token))) {
          throw new Error('HTTP ' + r.status + ': invalid taskId response; a task may have started. Check task history before retrying');
        }
        const href = '/tasks/' + encodeURIComponent(taskId) + '/log/view';
        successEl.innerHTML = 'Task launched. <a href="' + escape(href).replace(/"/g, '&quot;') + '">View task log</a>';
        document.getElementById('launchPrompt').value = '';
      } catch (e) {
        // A lost response does not prove the runner rejected the launch.
        errEl.textContent = 'launch failed: ' + safeMessage(e && e.message ? e.message : 'network request failed');
        if (uncertain) {
          errEl.textContent += ' Launch outcome unknown; a task may have started. Inspect task history before launching again.';
          errEl.innerHTML += ' <a href="#recentTasks">Task history</a>';
        }
      } finally {
        clearTimeout(timer);
        button.disabled = false;
        button.textContent = original;
      }
    }
    function wireNewTaskForm() {
      const form = document.getElementById('newTaskForm');
      if (form) form.onsubmit = submitNewTask;
      document.getElementById('launchRepo').onchange = renderLaunchRepoState;
      loadRepos();
    }
    function renderTasks(tasks) {
      const root = document.getElementById('tasks');
      if (!tasks.length) {
        root.innerHTML = '<div class="empty">' + (selectedRepo ? 'no matching runner tasks' : 'no active runner tasks') + '</div>';
        return;
      }
      root.innerHTML = tasks.map(t => {
        const statusClass = t.status ? 'status-' + t.status.replace(/[^a-z]/g, '') : '';
        // Only in-flight tasks get a live timer; anything else degrades to no label.
        const running = t.status === 'running' || t.status === 'queued';
        const elapsedLabel = running ? elapsed(t.createdAt) : '';
        const hasId = t.id != null && t.id !== '';
        const logUrl = '/tasks/' + encodeURIComponent(t.id) + '/log/view';
        const changesUrl = '/tasks/' + encodeURIComponent(t.id) + '/changes/view';
        const cancellation = cancellations.get(encodeURIComponent(t.id));
        return [
          '<div class="task-row">',
            '<div>',
              '<span class="id">' + escape(t.id) + '</span>',
              t.repo ? '<span class="repo">' + escape(t.repo) + '</span>' : '',
              t.status ? '<span class="status ' + statusClass + '">' + escape(t.status) + '</span>' : '',
              t.provider ? '<span class="provider">' + escape(t.provider) + '</span>' : '',
              elapsedLabel ? '<span class="elapsed">' + escape(elapsedLabel) + '</span>' : '',
              hasId ? '<a class="log" target="_blank" rel="noopener" href="' + escape(logUrl) + '">log</a>' : '',
              hasId ? '<a class="changes" target="_blank" rel="noopener" href="' + escape(changesUrl) + '">changes</a>' : '',
              hasId && running ? '<button type="button" class="cancel" data-task-id="' + encodeURIComponent(t.id) + '" onclick="cancelTask(this)"' + (cancellation && (cancellation.pending || cancellation.success) ? ' disabled' : '') + '>' + cancelLabel(cancellation) + '</button>' : '',
              hasId && running && cancellation && cancellation.message ? '<span class="cancel-err">' + escape(cancellation.message) + '</span>' : '',
            '</div>',
            t.branch ? '<div class="branch">branch: ' + escape(t.branch) + '</div>' : '',
            t.promptSnippet ? '<div class="intent">' + escape(t.promptSnippet) + '</div>' : '',
            '<div class="age">created ' + relTime(t.createdAt) + '</div>',
          '</div>'
        ].join('');
      }).join('');
    }
    async function retryTask(button) {
      // data-task-id is already encodeURIComponent'd, so it is a safe URL path
      // segment and a safe HTML attribute value.
      const encodedId = button.dataset.taskId;
      if (!encodedId) return;
      button.disabled = true;
      const original = button.textContent;
      button.textContent = 'retrying…';
      // Clear any stale feedback left from a previous attempt on this row.
      const row = button.closest ? button.closest('.task-row') : null;
      const prev = row ? row.querySelector('.retry-msg') : null;
      if (prev) prev.remove();
      const feedback = (cls, text) => {
        const span = document.createElement('span');
        span.className = 'retry-msg ' + cls;
        span.textContent = text;
        button.insertAdjacentElement('afterend', span);
      };
      try {
        const r = await fetch('/tasks/' + encodedId + '/retry', { method: 'POST', headers: authHeaders() });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        // 201: a fresh task was queued; the next history poll surfaces it on top.
        feedback('ok', 're-dispatched');
      } catch (e) {
        // Non-2xx (401 under FORGE_AUTH_TOKEN, 409 if the task is not terminal) or
        // a network error: surface it inline — never a silent no-op.
        feedback('err', 'retry failed: ' + e.message);
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    }
    function renderRecentTasks(tasks) {
      const root = document.getElementById('recentTasks');
      const rows = Array.isArray(tasks) ? tasks.filter(t => !selectedRepo || t.repo === selectedRepo) : [];
      document.getElementById('recentCount').textContent = rows.length;
      if (!rows.length) {
        root.innerHTML = '<div class="empty">' + (selectedRepo ? 'no recent tasks for this repository' : 'no recent tasks') + '</div>';
        return;
      }
      root.innerHTML = rows.map(t => {
        const statusClass = t.status ? 'status-' + String(t.status).replace(/[^a-z]/g, '') : '';
        // Terminal rows are the only ones that carry a commit / error line or a
        // retry control; queued/running ones are still in flight.
        const terminal = t.status === 'completed' || t.status === 'failed';
        const hasId = t.id != null && t.id !== '';
        const shortSha = typeof t.commitSha === 'string' ? t.commitSha.slice(0, 7) : '';
        const changesUrl = '/tasks/' + encodeURIComponent(t.id) + '/changes/view';
        const logUrl = '/tasks/' + encodeURIComponent(t.id) + '/log/view';
        return [
          '<div class="task-row">',
            '<div>',
              '<span class="id">' + escape(t.id) + '</span>',
              t.repo ? '<span class="repo">' + escape(t.repo) + '</span>' : '',
              t.provider ? '<span class="provider">' + escape(t.provider) + '</span>' : '',
              t.status ? '<span class="status ' + statusClass + '">' + escape(t.status) + '</span>' : '',
              t.status === 'completed' && shortSha ? '<span class="commit">' + escape(shortSha) + '</span>' : '',
              hasId ? '<a class="log" target="_blank" rel="noopener" href="' + escape(logUrl) + '">log</a>' : '',
              hasId ? '<a class="changes" target="_blank" rel="noopener" href="' + escape(changesUrl) + '">changes</a>' : '',
              hasId && terminal ? '<button type="button" class="retry" data-task-id="' + encodeURIComponent(t.id) + '" onclick="retryTask(this)">retry</button>' : '',
            '</div>',
            t.status === 'failed' && t.errorMessage ? '<div class="error-message">' + escape(t.errorMessage) + '</div>' : '',
            '<div class="age">created ' + relTime(t.createdAt) + '</div>',
          '</div>'
        ].join('');
      }).join('');
    }
    let recentTasksTimer;
    let recentTasksRequest = 0;
    let recentTasksLastSuccess = null;
    let cancelRecentTasks;
    function recentTasksHealth(reason) {
      document.getElementById('recentHealth').textContent =
        (reason ? (recentTasksLastSuccess ? 'Recent tasks stale' : 'Recent tasks unavailable') + ' · ' + reason : 'Recent tasks current') +
        ' · last update: ' + (recentTasksLastSuccess ? recentTasksLastSuccess.toLocaleString() : 'never');
    }
    async function refreshRecentTasks() {
      clearTimeout(recentTasksTimer);
      const request = ++recentTasksRequest;
      if (cancelRecentTasks) cancelRecentTasks();
      const repo = selectedRepo;
      const controller = new AbortController();
      let timeout;
      try {
        // Bound both fetch and body parsing, even if abort is ignored.
        const rows = await Promise.race([
          (async () => {
            const r = await fetch('/tasks?limit=15' + (repo ? '&repo=' + encodeURIComponent(repo) : ''), { signal: controller.signal });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.json();
          })(),
          new Promise((_, reject) => {
            cancelRecentTasks = () => {
              clearTimeout(timeout);
              controller.abort();
              reject(new Error('request superseded'));
            };
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error('request timed out'));
            }, 10000);
          })
        ]);
        if (request !== recentTasksRequest) return;
        if (!Array.isArray(rows) || !rows.every(t => record(t) &&
          ['id', 'repo', 'status', 'provider', 'createdAt', 'commitSha', 'errorMessage'].every(k => t[k] == null || typeof t[k] === 'string'))) {
          throw new Error('invalid task history');
        }
        renderRecentTasks(rows);
        recentTasksLastSuccess = new Date();
        recentTasksHealth();
      } catch (e) {
        if (request === recentTasksRequest) recentTasksHealth(e.message);
      } finally {
        clearTimeout(timeout);
        if (request === recentTasksRequest) {
          cancelRecentTasks = null;
          recentTasksTimer = setTimeout(refreshRecentTasks, 5000);
        }
      }
    }
    let latestSnapshot = null;
    let selectedRepo = '';
    let selectedEventType = '';
    const eventTypeFilter = document.getElementById('eventTypeFilter');
    eventTypeFilter.onchange = () => {
      selectedEventType = eventTypeFilter.value;
      renderSnapshot();
    };
    let selectedTicket = '';
    const ticketFilter = document.getElementById('ticketFilter');
    ticketFilter.onchange = () => {
      selectedTicket = ticketFilter.value;
      renderSnapshot();
    };
    let selectedActivity = 'all';
    const activityFilter = document.getElementById('activityFilter');
    activityFilter.onchange = () => {
      selectedActivity = activityFilter.value;
      renderSnapshot();
    };
    const repoFilter = document.getElementById('repoFilter');
    repoFilter.onchange = () => {
      selectedRepo = repoFilter.value;
      renderSnapshot();
      renderRecentTasks([]);
      recentTasksLastSuccess = null;
      recentTasksHealth('loading');
      if (typeof window !== 'undefined') refreshRecentTasks();
    };
    const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const count = v => Number.isSafeInteger(v) && v >= 0;
    function capacityText(c) {
      // Best-effort: only an older runner (absent) or a malformed value yields '—'.
      // Never throws — the capacity stat degrades independently of the rest of the board.
      return record(c) && count(c.activeTasks) && count(c.maxConcurrentTasks) && count(c.availableSlots)
        ? 'slots: ' + c.activeTasks + '/' + c.maxConcurrentTasks + ' (' + c.availableSlots + ' free)'
        : '—';
    }
    function renderSnapshot() {
      if (!latestSnapshot) return;
      const d = latestSnapshot;
      const eventIds = new Set(d.recentEvents.map(e => String(e.id)));
      for (const id of openEventDetails) {
        if (!eventIds.has(id)) openEventDetails.delete(id);
      }
      const liveTasks = Array.isArray(d.liveTasks) ? d.liveTasks : [];
      const repos = new Set([
        ...Object.keys(d.liveByRepo),
        ...d.liveAgents.map(a => a.repo),
        ...d.recentEvents.map(e => e.repo),
        ...liveTasks.map(t => t.repo),
        ...(selectedRepo ? [selectedRepo] : [])
      ].filter(repo => typeof repo === 'string' && repo.length));
      repoFilter.innerHTML = '<option value="">All repositories</option>' +
        [...repos].sort().map(repo => '<option value="' + escape(repo).replace(/"/g, '&quot;') + '">' + escape(repo) + '</option>').join('');
      repoFilter.value = selectedRepo;
      const tickets = new Set([
        ...d.liveAgents.map(a => a.ticket),
        ...d.recentEvents.map(e => e.ticket),
        ...(selectedTicket ? [selectedTicket] : [])
      ].filter(ticket => typeof ticket === 'string' && ticket.length));
      ticketFilter.innerHTML = '<option value="">All tickets</option>' +
        [...tickets].sort().map(ticket => '<option value="' + escape(ticket).replace(/"/g, '&quot;') + '">' + escape(ticket) + '</option>').join('');
      ticketFilter.value = selectedTicket;
      const matches = row => !selectedRepo || row.repo === selectedRepo;
      const ticketMatches = row => !selectedTicket || row.ticket === selectedTicket;
      const agents = d.liveAgents.filter(a => {
        const finished = ['done', 'aborted', 'failed'].includes(a.status);
        return matches(a) && ticketMatches(a) && (selectedActivity === 'all' ||
          (selectedActivity === 'finished' ? finished : !finished));
      });
      const eventTypes = new Set([
        ...d.recentEvents.map(e => e.eventType),
        ...(selectedEventType ? [selectedEventType] : [])
      ]);
      eventTypeFilter.innerHTML = '<option value="">All event types</option>' +
        [...eventTypes].sort().map(type => '<option value="' + escape(type).replace(/"/g, '&quot;') + '">' + escape(type) + '</option>').join('');
      eventTypeFilter.value = selectedEventType;
      const events = d.recentEvents.filter(matches).filter(ticketMatches).filter(e => !selectedEventType || e.eventType === selectedEventType);
      // Own tasks are always queued/running (i.e. "working"); hide them when the
      // activity filter narrows to finished agents.
      const tasks = selectedActivity === 'finished' ? [] : liveTasks.filter(matches);
      const liveCount = agents.length;
      const eventCount = events.length;
      document.getElementById('liveCount').textContent = liveCount;
      document.getElementById('eventCount').textContent = eventCount;
      document.getElementById('liveCount2').textContent = liveCount;
      document.getElementById('eventCount2').textContent = eventCount;
      document.getElementById('taskCount2').textContent = tasks.length;
      document.getElementById('capacity').textContent = capacityText(d.capacity);
      renderAgents(agents);
      renderEvents(events);
      renderTasks(tasks);
      renderEventCoverage(d);
      const byRepo = Object.create(null);
      for (const agent of agents) {
        if (agent.repo) byRepo[agent.repo] = (byRepo[agent.repo] || 0) + 1;
      }
      renderByRepo(byRepo, 'byRepo');
      const tasksByRepo = Object.create(null);
      for (const task of tasks) {
        if (task.repo) tasksByRepo[task.repo] = (tasksByRepo[task.repo] || 0) + 1;
      }
      renderByRepo(tasksByRepo, 'tasksByRepo');
    }
    function validSnapshot(d) {
      const fields = (v, names) => record(v) && names.every(k => v[k] == null || typeof v[k] === 'string');
      const byRepo = v => record(v) && Object.values(v).every(count);
      return record(d) && typeof d.generatedAt === 'string' && Number.isFinite(Date.parse(d.generatedAt)) &&
        count(d.liveAgentsCount) && count(d.recentEventsCount) &&
        Array.isArray(d.liveAgents) && d.liveAgents.every(a =>
          fields(a, ['agentId', 'repo', 'ticket', 'status', 'intent', 'updatedAt', 'branch']) &&
          (a.filesTouched == null || (Array.isArray(a.filesTouched) && a.filesTouched.every(file => typeof file === 'string')))) &&
        Array.isArray(d.recentEvents) && d.recentEvents.every(e => fields(e, ['eventType', 'repo', 'ticket', 'agentId', 'createdAt']) && typeof e.eventType === 'string' && (e.prNumber == null || count(e.prNumber))) &&
        byRepo(d.liveByRepo) &&
        (d.liveTasks === undefined || (Array.isArray(d.liveTasks) && d.liveTasks.every(t => fields(t, ['id', 'repo', 'branch', 'status', 'provider', 'promptSnippet', 'createdAt'])))) &&
        (d.liveTasksCount === undefined || count(d.liveTasksCount)) &&
        (d.liveTasksByRepo === undefined || byRepo(d.liveTasksByRepo));
    }
    let inFlight = false;
    let lastSuccess = null;
    function connection(connected, reason) {
      const el = document.getElementById('connection');
      el.className = connected ? 'connected' : '';
      el.textContent = (connected ? 'Connected' : 'Stale · ' + reason) +
        ' · last success: ' + (lastSuccess ? lastSuccess.toLocaleTimeString() : 'never');
      document.getElementById('connectionDot').className = connected ? 'dot' : 'dot stale';
    }
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      let timeout;
      try {
        const expired = new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('request timed out'));
          }, 10000);
        });
        // Race the whole body read too; a late completion cannot render after timeout.
        const d = await Promise.race([
          (async () => {
            const r = await fetch('/agent-context', { signal: controller.signal });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.json();
          })(),
          expired
        ]);
        if (!validSnapshot(d)) throw new Error('invalid snapshot');
        document.getElementById('generatedAt').textContent = 'generated ' + new Date(d.generatedAt).toLocaleTimeString();
        latestSnapshot = d;
        renderSnapshot();
        lastSuccess = new Date();
        connection(true);
      } catch (e) {
        connection(false, e.message);
      } finally {
        clearTimeout(timeout);
        inFlight = false;
        setTimeout(refresh, 5000);
      }
    }
    // Wire the launcher only in a real browser. The unit harness runs the script
    // in a bare VM with no window, so this keeps the one-poll-in-flight invariant
    // (dashboard-refresh asserts a single fetch at load); those tests drive the
    // launcher functions directly.
    if (typeof window !== 'undefined') {
      wireAuthToken();
      revealAuthIfRequired();
      wireNewTaskForm();
      // Defer the first history fetch one tick. A real browser runs the 0ms timer
      // immediately; the headless unit harnesses define window but never run
      // timers, so they never see a /tasks GET racing a launcher /tasks POST.
      recentTasksTimer = setTimeout(refreshRecentTasks, 0);
    }
    refresh();
  </script>
</body>
</html>`

dashboardRouter.get('/dashboard', (_req: Request, res: Response) => {
  const org = process.env.GITHUB_ORG || 'JanicsJophles'
  // JSON.stringify makes a JS string literal; also escape '<' as \u003c so a
  // '</script>' in the value can't break out of the inline <script> block.
  // Replacer function avoids String.replace $-pattern interpretation.
  const orgLiteral = JSON.stringify(org).replace(/</g, '\\u003c')
  const html = HTML.replace('__GITHUB_ORG__', () => orgLiteral)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(html)
})
