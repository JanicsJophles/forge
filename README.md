# Forge

Self-hosted [Claude Code](https://docs.anthropic.com/en/docs/claude-code) agent runner. Send it a repo + prompt, get streaming output back via SSE, and optionally auto-commit the result.

Run coding agents on your server while your laptop is closed.

## Features

- **Streaming output** — real-time SSE log streaming with reconnect support
- **Task management** — queue, monitor, and kill running agents
- **Auto-commit** — optionally commits changes when the agent finishes
- **Repo allowlist** — restricts which filesystem paths the agent can access
- **Concurrency limits** — configurable max concurrent tasks (returns 429 when full)
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
| `PORT` | `5000` | Server port |
| `ALLOWED_REPO_PATHS` | *(required)* | Comma-separated absolute paths the agent can access |
| `MAX_CONCURRENT_TASKS` | `2` | Max simultaneous agent runs |
| `AUTO_COMMIT` | `false` | Opt-in: commit changes after successful runs (set to `true`/`1`). A per-task `autoCommit` in the POST body overrides this |
| `COMMIT_MESSAGE_PREFIX` | `[forge]` | Prefix for auto-commit messages |
| `CLAUDE_RUN_USER` | `forge` | Unprivileged user to run claude as (for root-started servers) |
| `LOG_LEVEL` | `info` | Log verbosity |

## API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/tasks` | Create and start a task |
| `GET` | `/tasks` | List recent tasks (last 20) |
| `GET` | `/tasks/:id` | Get a single task |
| `GET` | `/tasks/:id/log` | Retrieve a bounded base64 byte slice (see below) |
| `GET` | `/tasks/:id/stream` | SSE stream (catches up on reconnect) |
| `DELETE` | `/tasks/:id` | Kill a running task |
| `GET` | `/repos` | List available git repos |
| `GET` | `/health` | Health check |

### POST /tasks body

```json
{
  "repo": "/repos/my-project",
  "branch": "main",
  "prompt": "Refactor the auth module to use JWT",
  "autoCommit": true
}
```

Only `repo` and `prompt` are required. `branch` defaults to the repo's current branch.

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

### Retrieve a task log in byte slices

`GET /tasks/:id/log?offset=0&limit=262144` returns
`{"data":"<base64>","offset":0,"nextOffset":262144,"totalBytes":500000}`.
`offset` is a zero-based byte offset (default `0`); `limit` is a positive byte
count (default and maximum `262144`, 256 KiB). Both accept only decimal digits
representing safe integers. Repeated, structured, malformed or out-of-range
values return JSON 400; a missing task returns JSON 404.

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
