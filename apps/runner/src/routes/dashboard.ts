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
    section.full { grid-column: 1 / -1; }
    section {
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
    .task-row .id { color: var(--accent); font-weight: 600; }
    .task-row .repo {
      display: inline-block;
      background: var(--panel-2);
      color: var(--text-dim);
      padding: 1px 6px;
      border-radius: 4px;
      margin-left: 6px;
      font-size: 11px;
    }
    .task-row .branch { color: var(--text-dim); margin-left: 6px; font-size: 11px; }
    .task-row .provider {
      display: inline-block;
      color: var(--text-mute);
      margin-left: 6px;
      font-size: 11px;
      text-transform: uppercase;
    }
    .task-row .status {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      margin-left: 6px;
    }
    .task-row .snippet {
      display: block;
      margin-top: 4px;
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.4;
    }
    .agent-row .id { color: var(--accent); font-weight: 600; }
    .agent-row .repo {
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
    .agent-row .intent {
      display: block;
      margin-top: 4px;
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.4;
    }
    .agent-row .updated {
      color: var(--text-mute);
      font-size: 11px;
      margin-top: 4px;
    }
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
    .by-repo {
      padding: 12px 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      border-top: 1px solid var(--border);
      background: var(--panel-2);
    }
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
    <h1><span class="dot"></span>forge · agent board</h1>
    <div class="meta">
      <span id="generatedAt">—</span> &middot;
      <b id="liveCount">0</b> live &middot;
      <b id="eventCount">0</b> events (24h)
    </div>
  </header>

  <main>
    <section class="full">
      <h2>Runner tasks <span class="count" id="taskCount2">0</span></h2>
      <div id="tasks"></div>
      <div class="by-repo" id="tasksByRepo"></div>
    </section>

    <section>
      <h2>Live agents <span class="count" id="liveCount2">0</span></h2>
      <div id="agents"></div>
      <div class="by-repo" id="byRepo"></div>
    </section>

    <section>
      <h2>Recent events <span class="count" id="eventCount2">0</span></h2>
      <div id="events"></div>
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
      if (!iso) return '';
      const t = new Date(iso.replace(' ', 'T') + 'Z');
      const now = new Date();
      const sec = Math.floor((now - t) / 1000);
      if (sec < 60) return sec + 's ago';
      if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
      if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
      return Math.floor(sec / 86400) + 'd ago';
    }
    function renderTasks(tasks) {
      const root = document.getElementById('tasks');
      if (!tasks.length) {
        root.innerHTML = '<div class="empty">no queued or running tasks</div>';
        return;
      }
      root.innerHTML = tasks.map(t => {
        const statusClass = t.status ? 'status-' + t.status.replace(/[^a-z]/g, '') : '';
        return [
          '<div class="task-row">',
            '<div>',
              '<span class="id">' + escape((t.id || '').slice(0, 8)) + '</span>',
              t.repo ? '<span class="repo">' + escape(t.repo) + '</span>' : '',
              t.branch ? '<span class="branch">' + escape(t.branch) + '</span>' : '',
              t.status ? '<span class="status ' + statusClass + '">' + escape(t.status) + '</span>' : '',
              t.provider ? '<span class="provider">' + escape(t.provider) + '</span>' : '',
            '</div>',
            t.promptSnippet ? '<div class="snippet">' + escape(t.promptSnippet) + '</div>' : '',
          '</div>'
        ].join('');
      }).join('');
    }
    function renderAgents(agents) {
      const root = document.getElementById('agents');
      if (!agents.length) {
        root.innerHTML = '<div class="empty">no live agents</div>';
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
            a.intent ? '<div class="intent">' + escape(a.intent) + '</div>' : '',
            '<div class="updated">updated ' + relTime(a.updatedAt) + '</div>',
          '</div>'
        ].join('');
      }).join('');
    }
    function renderEvents(events) {
      const root = document.getElementById('events');
      if (!events.length) {
        root.innerHTML = '<div class="empty">no events in last 24h</div>';
        return;
      }
      root.innerHTML = events.map(e => {
        const typeClass = 'type-' + e.eventType.replace(/[^a-z_]/g, '');
        let prHtml = '';
        if (e.prNumber && e.repo) {
          const repoSlug = e.repo.replace(/^.*\\//, '');
          prHtml = '<span class="pr"><a target="_blank" href="https://github.com/' + escape(GITHUB_ORG) + '/' + escape(repoSlug) + '/pull/' + escape(e.prNumber) + '">PR#' + escape(e.prNumber) + '</a></span>';
        } else if (e.prNumber) {
          prHtml = '<span class="pr">PR#' + escape(e.prNumber) + '</span>';
        }
        return [
          '<div class="event-row">',
            '<span class="time">' + relTime(e.createdAt) + '</span>',
            '<span class="type ' + typeClass + '">' + escape(e.eventType) + '</span>',
            e.repo ? '<span class="repo">' + escape(e.repo) + '</span>' : '',
            e.ticket ? '<span class="ticket">' + escape(e.ticket) + '</span>' : '',
            prHtml,
            e.agentId ? '<span class="agent">by ' + escape(e.agentId.slice(0, 24)) + '</span>' : '',
          '</div>'
        ].join('');
      }).join('');
    }
    function renderByRepo(by, rootId) {
      const root = document.getElementById(rootId || 'byRepo');
      const entries = Object.entries(by || {});
      if (!entries.length) { root.innerHTML = ''; return; }
      root.innerHTML = entries.map(([repo, n]) => '<span class="pill"><b>' + n + '</b>' + escape(repo) + '</span>').join('');
    }
    async function refresh() {
      try {
        const r = await fetch('/agent-context');
        const d = await r.json();
        document.getElementById('generatedAt').textContent = 'generated ' + new Date(d.generatedAt).toLocaleTimeString();
        document.getElementById('liveCount').textContent = d.liveAgentsCount;
        document.getElementById('eventCount').textContent = d.recentEventsCount;
        document.getElementById('liveCount2').textContent = d.liveAgentsCount;
        document.getElementById('eventCount2').textContent = d.recentEventsCount;
        document.getElementById('taskCount2').textContent = d.liveTasksCount || 0;
        renderTasks(d.liveTasks || []);
        renderByRepo(d.liveTasksByRepo || {}, 'tasksByRepo');
        renderAgents(d.liveAgents || []);
        renderEvents(d.recentEvents || []);
        renderByRepo(d.liveByRepo || {});
      } catch (e) {
        document.getElementById('agents').innerHTML = '<div class="err">fetch failed: ' + escape(e.message) + '</div>';
      }
    }
    refresh();
    setInterval(refresh, 5000);
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
