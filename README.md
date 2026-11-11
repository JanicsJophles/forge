# Forge

Self-hosted [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agent runner. Send it a repo + prompt, get streaming output back via SSE, and optionally auto-commit the result.

Run coding agents on your server while your laptop is closed.

## Features

- **Streaming output** — real-time SSE log streaming with reconnect support
- **Task management** — queue, monitor, retry, and kill running agents
- **Auto-commit** — optionally commits changes when the agent finishes
- **Repo allowlist** — restricts which filesystem paths the agent can access
- **Concurrency limits** — configurable max concurrent tasks (returns 429 when full)
- **Disk guard** — refuses new tasks when free disk drops below a threshold (returns 507)
- **Task timeout** — SIGTERM then SIGKILL a hung agent after a configurable limit
- **Optional bearer auth** — gate state-changing routes behind a token; reads stay open
- **Agent coordination surface** — a lightweight board (`/agent-state`, `/agent-events`, `/agent-context`) plus a live HTML `/dashboard`
- **Self-contained** — SQLite for task storage, no external database required

## Quick start

### With Docker

```bash
git clone https://github.com/yourusername/forge.git
cd forge

cp apps/runner/.env.example apps/runner/.env
# Edit .env — set ALLOWED_REPO_PATHS to the directories containing your repos

# Set FORGE_REPOS_DIR to the parent directory of your repos
FORGE_REPOS_DIR=~/projects docker compose up
```

### Without Docker

Requires Node.js 20+ and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code).

```bash
git clone https://github.com/yourusername/forge.git
cd forge

npm install
npm run build

cp apps/runner/.env.example apps/runner/.env
# Edit .env — set ALLOWED_REPO_PATHS

npm run dev
```

## Usage

### Start a task

```bash
curl -X POST http://localhost:5000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "/repos/my-project",
    "prompt": "Add input validation to the signup form"
  }'
# → { "taskId": "abc-123" }
```

### Stream output

```bash
curl -N http://localhost:5000/tasks/abc-123/stream
```

### List repos

```bash
curl http://localhost:5000/repos
```

### Kill a running task

```bash
curl -X DELETE http://localhost:5000/tasks/abc-123
```

## Configuration

All configuration is via environment variables (see [.env.example](apps/runner/.env.example)):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5000` | Server port (`1`–`65535`) |
| `HOST` | `0.0.0.0` | Address to bind the HTTP server to |
| `ALLOWED_REPO_PATHS` | *(required)* | Comma-separated absolute paths the agent can access |
| `MAX_CONCURRENT_TASKS` | `2` | Max simultaneous agent runs (capped at `64`) |
| `TASK_TIMEOUT_MS` | `1800000` | Hung-agent timeout: SIGTERM then SIGKILL a task that runs this long (30m default) |
| `MIN_FREE_DISK_MB` | `2048` | Admission disk guard: reject new tasks when free disk is below this many MB |
| `AUTO_COMMIT` | `false` | Opt-in: commit changes after successful runs (set to `true`/`1`). A per-task `autoCommit` in the POST body overrides this |
| `COMMIT_MESSAGE_PREFIX` | `[forge]` | Prefix for auto-commit messages |
| `FORGE_AUTH_TOKEN` | *(unset)* | Optional bearer token; when set, state-changing routes require `Authorization: Bearer <token>`. Unset/blank means auth is off |
| `FORGE_GIT_SHA` | *(unset)* | Short git SHA of the deployed build, appended to the reported `version` when set |
| `CLAUDE_RUN_USER` | `forge` | Unprivileged user to run the claude provider as (for root-started servers) |
| `CODEX_RUN_USER` | `forge` | Unprivileged user to run the codex provider as |
| `TASK_RETENTION_DAYS` | `0` (disabled) | Opt-in terminal task pruning at startup and every 24 hours; positive integer days |
| `LOG_LEVEL` | `info` | Log verbosity |

## API

Responses are JSON except HTML views (`/`, `/dashboard`, `/history`, and task
viewers), SSE streams, raw text logs, and patches. Unknown paths return `404 {"error":"not found"}`.

### Tasks

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/tasks` | Create and start a task → `201 {"taskId"}` |
| `GET` | `/tasks` | List task history, newest first (filterable + paginated) |
| `GET` | `/tasks/stats` | Aggregate task counts by status |
| `GET` | `/tasks/:id` | Get a single task (`?view=status\|detail` for a projection) |
| `GET` | `/tasks/:id/stream` | SSE stream (catches up on reconnect; `?replay=0` to skip catch-up) |
| `GET` | `/tasks/:id/changes` | Recorded commit or current-checkout footprint; `?format=patch` for a bounded diff |
| `GET` | `/tasks/:id/changes/view` | HTML patch review with the same source and bounds |
| `GET` | `/tasks/:id/log/view` | Live HTML log viewer with SSE reconnect support |
| `GET` | `/history` | HTML task history browser with filters, pagination, and log viewer links |
| `GET` | `/tasks/:id/log` | Retrieve the log as a byte slice, line tail, or download (see below) |
| `POST` | `/tasks/:id/retry` | Re-dispatch a terminal task's stored inputs as a new task → `201 {"taskId"}` |
| `DELETE` | `/tasks/:id` | Cancel a queued task or kill a running one |

### Repos, health & capabilities

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/repos` | List allowed git checkout roots and their immediate children |
| `GET` | `/health` | Health + capacity + disk snapshot |
| `GET` | `/capabilities` | Provider list, limits, and logging bounds |

### Agent coordination

A lightweight board local and remote agents checkpoint their state to; also drives `/dashboard`.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/agent-state/checkpoint` | Upsert this agent's live state |
| `GET` | `/agent-state` | List live (non-expired) agents (`?repo=`, `?ticket=`, `?includeExpired=`) |
| `GET` | `/agent-state/:agentId` | Fetch one agent's state |
| `DELETE` | `/agent-state/:agentId` | Remove an agent (clean shutdown) |
| `POST` | `/agent-events` | Append a transition event |
| `GET` | `/agent-events` | List recent events (`?since=`, `?afterId=`, `?repo=`, `?ticket=`, `?type=`, `?agentId=`, `?limit=`) |
| `GET` | `/agent-context` | Combined snapshot: live agents + last 24h of events + runner capacity (`?repo=`, `?since=`) |
| `GET` | `/dashboard` | Live HTML view of the board (polls `/agent-context`) |

### Authentication

Auth is **off by default**: every route is open. Set `FORGE_AUTH_TOKEN` to require a
bearer token on state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`):

```bash
curl -X POST http://localhost:5000/tasks \
  -H "Authorization: Bearer $FORGE_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "repo": "/repos/my-project", "prompt": "..." }'
```

Reads (`GET`/`HEAD`/`OPTIONS`) are never challenged, so health checks, the dashboard,
and board snapshots keep working without a credential. A mutating request with a
missing or wrong token gets `401 {"error":"unauthorized"}`. Clients can discover
whether a token is required from the `authRequired` field of `GET /capabilities`.

### POST /tasks body

```json
{
  "repo": "/repos/my-project",
  "branch": "main",
  "prompt": "Refactor the auth module to use JWT",
  "provider": "claude",
  "model": "claude-sonnet-4-6",
  "autoCommit": true
}
```

Only `repo` and `prompt` are required. `branch` defaults to the repo's current branch
(and, when supplied, must match the checkout). `provider` is `claude` (default) or
`codex`. `model` is optional (`1`–`100` chars, `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`).
`autoCommit` overrides the `AUTO_COMMIT` config default for this task.

Admission can reject with `400` (bad input / repo not allowlisted), `409` (the
checkout already has an active task, or the branch claim mismatches), `429` (max
concurrent tasks reached), or `507` (free disk below `MIN_FREE_DISK_MB`).

### GET /tasks query parameters

`repo` (exact stored value), `status` (`queued`/`running`/`completed`/`failed`),
`limit` (`1`–`100`, default `20`), and `before` (an exclusive task-ID cursor). When
another page exists the response sets an `X-Next-Before` header — reuse that ID as
`before` with the same filters. The body is always a JSON array.

### GET /tasks/stats

```json
{ "queued": 0, "running": 1, "completed": 42, "failed": 3, "total": 46 }
```

`total` is the sum of the four reported buckets.

### GET /health

```json
{
  "status": "ok",
  "version": "0.1.0",
  "activeTasks": 1,
  "queuedOrRunning": 1,
  "maxConcurrentTasks": 2,
  "taskTimeoutMs": 1800000,
  "minFreeDiskMb": 2048,
  "freeDiskMb": 51200,
  "diskOk": true,
  "dataFreeDiskMb": 51200,
  "dataDiskOk": true,
  "acceptingTasks": true,
  "notAcceptingReason": null,
  "uptimeSeconds": 3600,
  "oldestRunningTaskAgeSeconds": 42
}
```

`activeTasks` counts live child processes; `queuedOrRunning` counts queued+running
rows. `freeDiskMb`/`diskOk` cover the repo volume and `dataFreeDiskMb`/`dataDiskOk`
the volume backing `forge.db`; either disk field is `null` if it can't be measured.
`oldestRunningTaskAgeSeconds` is `null` when nothing is running.

`status: "ok"` reports liveness, even when readiness is false. `acceptingTasks`
is true only when both disk checks are true and `queuedOrRunning` is below
`maxConcurrentTasks`. `notAcceptingReason` is null when accepting; otherwise its
precedence is `unknown` (either disk measurement unavailable), `disk` (repo volume),
`dataDisk` (SQLite volume), then `concurrency`. This is a snapshot, not a reservation:
submission still validates the requested checkout and its active-task ownership.
`taskTimeoutMs` and `minFreeDiskMb` expose the configured deadline and disk floor.
The repo measurement uses the first allowed repo path; admission checks the target.
Readiness treats unknown disk measurements as unavailable; admission currently logs
measurement failures and continues its other checks.

### GET /capabilities

```json
{
  "providerSelectionVersion": 1,
  "providers": ["claude", "codex"],
  "version": "0.1.0",
  "authRequired": false,
  "build": {
    "version": "0.1.0",
    "gitShaPinned": false,
    "commitMessagePrefix": "[forge]"
  },
  "limits": {
    "maxConcurrentTasks": 2,
    "taskTimeoutMs": 1800000,
    "minFreeDiskMb": 2048,
    "autoCommit": false
  },
  "logging": { "maxSliceBytes": 262144, "detailTailBytes": 262144 }
}
```

`version` (also `build.version`) includes `+<FORGE_GIT_SHA>` when configured;
`build.gitShaPinned` indicates whether that setting is present. Provider discovery
does not probe CLI authentication. Retention is not exposed in this response.

The legacy `GET /tasks/capabilities` alias has been removed. Use `GET /capabilities`
for discovery. The old path now follows `GET /tasks/:id`: when no task with ID
`capabilities` exists, it returns HTTP 404 with `{"error":"task not found"}`.

### GET /tasks/:id/changes

```json
{
  "taskId": "abc-123",
  "repo": "/repos/my-project",
  "branch": "main",
  "summary": { "added": 0, "modified": 1, "deleted": 0, "renamed": 0, "copied": 0, "untracked": 0, "total": 1 },
  "changedFiles": [{ "path": "src/app.ts", "status": "M" }],
  "truncated": false
}
```

When the task has a recorded `commitSha`, JSON, patch, and HTML review inspect
that commit, even after HEAD or the working tree changes. Root commits compare
against the empty tree; merge commits compare against their first parent. An
unavailable recorded commit returns `503`; it does not fall back to current changes.

Without a recorded commit, review falls back to tracked changes against the
checkout's current HEAD, plus untracked paths in JSON. **Uncommitted history reflects
the current checkout**, not a saved task diff; later edits can change an old task's
review. Untracked file contents are absent from patches.

`summary` counts the full selected footprint; `changedFiles` contains at most 2000
entries, with `truncated: true` when bounded. Statuses are Git letters (`A`, `M`,
`D`, `R…`, `C…`, `?`); rename/copy paths are destinations.

`?format=patch` returns `text/plain` unified diff, retaining the first 1,000,000
bytes and setting `X-Patch-Truncated: true|false`. The HTML viewer uses the same
cap and shows a truncation notice. Git probes time out after two seconds; patches
exceeding the 64 MiB capture buffer fail with `503`. Missing tasks return `404`;
invalid, repeated, or structured `format` values return `400`. Inspection failures
return `503` without raw Git diagnostics.

### Retention

`TASK_RETENTION_DAYS` is disabled when unset or `0`; invalid values warn and disable
pruning. A positive integer enables pruning at startup and every 24 hours. Only
completed/failed tasks with `completed_at` strictly older than the configured age
are deleted, including their stored transcripts; queued/running tasks are retained.
Deleted tasks no longer appear in history or review endpoints. SQLite pages become
reusable; pruning does not physically shrink the database file or run VACUUM.

### SSE replay and reconnect

Each connection replays a fresh stored tail (up to 262144 bytes, with an earlier-output
truncation marker when needed), then current status or the terminal event, followed
by live output while running. `?replay=0` (also `false`) skips stored output but keeps
status, live, and terminal events. This is tail catch-up, not an offset-based resume;
there are no event IDs for exact replay. Use the paginated log endpoint for older bytes.
The HTML log viewer retains displayed output during a network failure, then replaces
it with the fresh replay on successful reconnect and displays a replacement notice.

### SSE event types

| Event | Description |
|---|---|
| `log` | Stdout/stderr output from the agent |
| `status` | Task status change (e.g., `running`) |
| `complete` | Task finished successfully |
| `error` | Task failed |

## Production deployment

Use PM2 for process management:

```bash
npm run build
cd apps/runner
pm2 start pm2.config.cjs
pm2 save
```

See [scripts/setup.sh](scripts/setup.sh) for a full server setup script (installs Node, PM2, Claude CLI on Debian/Ubuntu).

## Architecture

```
Client (curl / UI / CI)
  │
  ▼
Express API (port 5000)
  ├── POST /tasks → validate repo → spawn claude CLI
  │                                    │
  │                                    ├── stdout → buffer (500ms) → SSE + SQLite
  │                                    ├── stderr → buffer (500ms) → SSE + SQLite
  │                                    └── exit → auto-commit → complete/fail
  │
  ├── GET /tasks/:id/stream → SSE (catch-up from DB + live from EventEmitter)
  │
  └── SQLite (task history, logs)
```

## License

MIT

### Retrieve a task log

`GET /tasks/:id/log` serves the log three ways. Every response carries an
`X-Task-Status` header (the task's current status) so a tail loop knows when to stop.

**Byte slice (default).** `GET /tasks/:id/log?offset=0&limit=262144` returns
`{"data":"<base64>","offset":0,"nextOffset":262144,"totalBytes":500000}`.
`offset` is a zero-based byte offset (default `0`); `limit` is a positive byte
count (default and maximum `262144`, 256 KiB). Both accept only decimal digits
representing safe integers. Repeated, structured, malformed or out-of-range
values return JSON 400; a missing task returns JSON 404.

**Line tail.** `?tailLines=N` (a positive integer) returns the last `N` lines of the
whole log instead of a byte window. It cannot be combined with `offset` or `limit`
(returns 400). The response shares the same slice shape (or raw text, below).

**Raw text & download.** `?format=text` returns the decoded bytes as
`text/plain` (with `X-Total-Bytes` and `X-Next-Offset` headers) instead of the
base64 JSON envelope. `?download=1` additionally serves the text as a file
attachment (`Content-Disposition`); it requires `format=text`. The attachment
contains only the selected byte slice (default at most 262144 bytes) or line tail,
not an automatic complete transcript. Use pagination for a complete log.

`data` contains at most `limit` bytes encoded as base64. `nextOffset` equals
`offset` plus the decoded byte count; `totalBytes` is the log's byte length in
the same SQLite snapshot. Empty/NULL logs and offsets at or past EOF return
empty `data`, retaining the requested offset as `nextOffset`. Logs can grow:
resume from `nextOffset` to fetch appended bytes. Poll again later when it
reaches `totalBytes`. Slices may split UTF-8 characters; concatenate decoded
bytes before decoding text (or use a streaming UTF-8 decoder).

This Node.js example writes the current log snapshot without collecting it in
memory. Set `offset` to a saved `nextOffset` and append to the same file to resume.

```js
import { open } from 'node:fs/promises';
const taskId = 'abc-123';
let offset = 0;
const file = await open('task.log', 'a'); // use a new/empty file when offset is 0
try {
  let snapshotEnd;
  do {
    const response = await fetch(
      `http://localhost:5000/tasks/${encodeURIComponent(taskId)}/log?offset=${offset}&limit=262144`
    );
    if (!response.ok) throw new Error(await response.text());
    const slice = await response.json();
    snapshotEnd ??= slice.totalBytes;
    await file.writeFile(Buffer.from(slice.data, 'base64'));
    if (slice.nextOffset === offset) break;
    offset = slice.nextOffset; // persist this after successfully writing the bytes
  } while (offset < snapshotEnd);
} finally {
  await file.close();
}
console.log({ nextOffset: offset });
```
