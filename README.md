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
| `CODEX_RUN_USER` | `forge` | Unprivileged user to run codex as |
| `READONLY_RUN_USER` | *(unset)* | Dedicated, credential-less account for read-only tasks. When unset or missing, `GET /tasks/capabilities` reports `readOnly: false` and read-only tasks are refused. See [Read-only tasks](#read-only-tasks). |
| `READONLY_CLAUDE_CONFIG_DIR` | *(unset)* | `CLAUDE_CONFIG_DIR` handed to read-only claude runs (its isolated auth dir) |
| `READONLY_CODEX_HOME` | *(unset)* | `CODEX_HOME` handed to read-only codex runs (its isolated auth dir) |
| `LOG_LEVEL` | `info` | Log verbosity |

## API

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/tasks` | Create and start a task |
| `GET` | `/tasks/capabilities` | Runner capabilities (providers, `readOnly`) |
| `GET` | `/tasks` | List recent tasks (last 20, log truncated) |
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
  "autoCommit": true,
  "readOnly": false
}
```

Only `repo` and `prompt` are required. `branch` defaults to the repo's current branch.

`readOnly` (default `false`) runs the task against a **disposable copy** of the
repo so the real repo is never written to — see [Read-only tasks](#read-only-tasks).
Check `GET /tasks/capabilities` for `readOnly: true` before relying on it; when the
runner is not configured for read-only, a `readOnly: true` request is rejected with
`400`. `GET /tasks` caps each task's `log` to its last 4,000 bytes and sets
`log_truncated: true` on any row that was cut; `GET /tasks/:id` returns the full log.

## Read-only tasks

A read-only task (`"readOnly": true`) lets an agent explore and reason about a repo
without any possibility of changing it. The enforcement is **structural, not just a
set of tool flags**:

1. **The agent never runs in the real repo.** Before launch the runner builds a
   disposable copy in a fresh temp dir with
   `git clone --no-local --no-hardlinks` (committed history only — no hardlinks into
   the real object store), then overlays the real repo's uncommitted **tracked**
   changes and **untracked, non-ignored** files so the agent sees the true working
   state. Ignored files (e.g. `.env`, `secret.log`) are deliberately **not** copied.
   The real repo is only ever *read*.
2. **The copy has nowhere to push.** Every remote is removed from the copy, so
   `git push`/`fetch` have no target.
3. **The agent runs as a separate, credential-less account.** Set
   `READONLY_RUN_USER` to a dedicated OS account (e.g. `forge-ro`) that owns nothing
   and holds no SSH keys, `gh` login, or `~/.git-credentials`. The copy is `chown`ed
   to that account and the process runs under its uid/gid.
4. **The environment is an explicit allowlist, not inherited.** The read-only process
   gets only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `TERM`, and the provider's
   isolated auth dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`). Inherited tokens such as
   `GH_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
   `OPENAI_API_KEY`, and `AWS_*` are stripped.
5. **Defense in depth on the claude side.** Read-only claude runs drop
   `--dangerously-skip-permissions` and instead pin `--permission-mode plan`,
   `--setting-sources ""` (so a repo `.claude/settings.json` cannot re-enable tools),
   `--strict-mcp-config` (so a repo `.mcp.json` is ignored), and an explicit
   `--allowedTools`/`--disallowedTools` fence limiting the agent to read-only tools.
   For codex, the disposable copy + isolated account *is* the enforcement.
6. **Fail closed.** If `READONLY_RUN_USER` is unset or the account doesn't exist,
   `GET /tasks/capabilities` reports `readOnly: false` and read-only requests are
   rejected with `400`. Any error preparing the copy fails the task **before** the
   agent starts.
7. **Whole-process-group teardown.** The agent is spawned in its own process group;
   cancel/close sends `SIGTERM` to the entire group (not just the leader), so
   backgrounded children don't outlive the task. The disposable copy is then removed.

After the run, the runner records an informational report of what changed **inside
the copy** (`git status --porcelain=v2 --ignored` plus any commits the agent made);
the real repo and its remotes are never inspected or modified.

### What read-only does NOT guarantee

- **Network egress is not blocked.** The agent can still make outbound network calls
  (it just has no credentials and no git remotes). If you need egress isolation, run
  the runner inside a network-restricted container/namespace.
- It is not a sandbox for arbitrary host damage outside the copy — it relies on the
  `READONLY_RUN_USER` account owning nothing the agent should be able to touch.

### One-time host setup

Create the isolated account and give it its own provider auth (run once, as root):

```bash
# 1. A credential-less account that owns nothing.
useradd --system --create-home --shell /usr/sbin/nologin forge-ro

# 2. Isolated auth dirs for the read-only account (owned by it).
install -d -o forge-ro -g forge-ro /etc/forge-ro/claude /etc/forge-ro/codex

# 3. Log that account into claude / codex once, writing into those dirs:
sudo -u forge-ro CLAUDE_CONFIG_DIR=/etc/forge-ro/claude claude   # /login
sudo -u forge-ro CODEX_HOME=/etc/forge-ro/codex codex login

# 4. Point the runner at it (in apps/runner/.env):
#    READONLY_RUN_USER=forge-ro
#    READONLY_CLAUDE_CONFIG_DIR=/etc/forge-ro/claude
#    READONLY_CODEX_HOME=/etc/forge-ro/codex
```

The runner must itself start as root for the uid/gid drop and `chown` to work.

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
