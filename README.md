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
| `AUTO_COMMIT` | `true` | Commit changes after successful runs |
| `COMMIT_MESSAGE_PREFIX` | `[forge]` | Prefix for auto-commit messages |
| `CLAUDE_RUN_USER` | `forge` | Unprivileged user to run claude as (for root-started servers) |
| `LOG_LEVEL` | `info` | Log verbosity |

## API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/tasks` | Create and start a task |
| `GET` | `/tasks` | List recent tasks (last 20) |
| `GET` | `/tasks/:id` | Get a single task |
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

### Verified completion

After a successful agent exit and optional auto-commit, the runner checks the final
repository state before setting `completed`. Prompts containing the word `PR`
require a claimed GitHub PR URL or `branch: name` in agent output, an open draft PR,
and matching local, PR and remote branch heads. `verify: false` skips those PR
checks. It does not disable gates or diff checks.

POST /tasks also accepts `gate`, `base` (otherwise PR base or `main`),
`allowedDependencies` (package names), `maxWallMinutes` and `maxOutputBytes`.
The runner executes `gate`, or the command in `.forge/gate`, directly in bash in
the task repo with a timeout and records its real exit code and last 16 KiB of
output. It uses the agent's uid, gid and HOME for verification commands.

GET /tasks/:id includes the saved `options` and `verification` report. `unverified`
means a required check failed; `capped` means the wall time or output budget was
exceeded. Both are terminal states with an errorMessage and completedAt. SSE uses
the existing error event for either state. Removed cases and assertions are review
warnings. Deleted tests and new skip/only markers require `test-change:` followed
by a justification in the PR body. Env files, likely secrets and unauthorized
workflow edits block completion; new dependencies outside the allowlist warn.
These diff checks are heuristics, not a complete security scanner.

Owner defaults and ceilings are in apps/runner/.env.example. Workflow permission
and additional forbidden diff regexes are owner env settings, never request
permissions. Agents get SIGTERM on a cap, then SIGKILL after one second, applied
to their process group. No service restart is needed to run the offline checks:

```sh
npm run build
npm test
npm run canary --workspace=apps/runner
```

Tests and canary create scratch repos in the system temp directory and use a fake
`gh` binary. They do not require GitHub access or the live runner database.
