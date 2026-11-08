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
    #repoFilter, #activityFilter, #eventTypeFilter { background: var(--panel); color: var(--text); border: 1px solid var(--border); padding: 4px 8px; }
    .by-repo .pill {
      background: var(--panel);
      border: 1px solid var(--border);
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      color: var(--text-dim);
    }
    .by-repo .pill b { color: var(--accent); margin-right: 4px; }
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
      <b id="eventCount">0</b> events shown (recent snapshot)
    </div>
  </header>

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
      <h2>Runner tasks (own) <span class="count" id="taskCount2">0</span></h2>
      <div id="tasks"></div>
      <div class="by-repo" id="tasksByRepo"></div>
    </section>
  </main>

  <footer>
    Auto-refreshes every 5s. Source: <code>/agent-context</code> &middot; LXC 207 &middot; forge-runner
  </footer>

  <script>
    const GITHUB_ORG = __GITHUB_ORG__;
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
    function renderAgents(agents) {
      const root = document.getElementById('agents');
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
            a.filesTouched && a.filesTouched.length ? '<details class="claimed-files"><summary>Claimed files (' + a.filesTouched.length + ')</summary><ul>' +
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
        root.innerHTML = '<div class="empty">' + ((selectedRepo || selectedEventType) ? 'no matching events in recent snapshot' : 'no events in recent snapshot') + '</div>';
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
    function renderTasks(tasks) {
      const root = document.getElementById('tasks');
      if (!tasks.length) {
        root.innerHTML = '<div class="empty">' + (selectedRepo ? 'no matching runner tasks' : 'no active runner tasks') + '</div>';
        return;
      }
      root.innerHTML = tasks.map(t => {
        const statusClass = t.status ? 'status-' + t.status.replace(/[^a-z]/g, '') : '';
        return [
          '<div class="task-row">',
            '<div>',
              '<span class="id">' + escape(t.id) + '</span>',
              t.repo ? '<span class="repo">' + escape(t.repo) + '</span>' : '',
              t.status ? '<span class="status ' + statusClass + '">' + escape(t.status) + '</span>' : '',
            '</div>',
            t.branch ? '<div class="branch">branch: ' + escape(t.branch) + '</div>' : '',
            t.promptSnippet ? '<div class="intent">' + escape(t.promptSnippet) + '</div>' : '',
            '<div class="age">created ' + relTime(t.createdAt) + '</div>',
          '</div>'
        ].join('');
      }).join('');
    }
    let latestSnapshot = null;
    let selectedRepo = '';
    let selectedEventType = '';
    const eventTypeFilter = document.getElementById('eventTypeFilter');
    eventTypeFilter.onchange = () => {
      selectedEventType = eventTypeFilter.value;
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
    };
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
      const matches = row => !selectedRepo || row.repo === selectedRepo;
      const agents = d.liveAgents.filter(a => {
        const finished = ['done', 'aborted', 'failed'].includes(a.status);
        return matches(a) && (selectedActivity === 'all' ||
          (selectedActivity === 'finished' ? finished : !finished));
      });
      const eventTypes = new Set([
        ...d.recentEvents.map(e => e.eventType),
        ...(selectedEventType ? [selectedEventType] : [])
      ]);
      eventTypeFilter.innerHTML = '<option value="">All event types</option>' +
        [...eventTypes].sort().map(type => '<option value="' + escape(type).replace(/"/g, '&quot;') + '">' + escape(type) + '</option>').join('');
      eventTypeFilter.value = selectedEventType;
      const events = d.recentEvents.filter(matches).filter(e => !selectedEventType || e.eventType === selectedEventType);
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
      const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
      const count = v => Number.isSafeInteger(v) && v >= 0;
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
