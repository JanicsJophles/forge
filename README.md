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
| `READONLY_CLAUDE_CONFIG_DIR` | *(unset)* | Pristine `CLAUDE_CONFIG_DIR` source for read-only claude runs (copied per-task into a 0700 ephemeral HOME) |
| `READONLY_CODEX_HOME` | *(unset)* | Pristine `CODEX_HOME` source for read-only codex runs (copied per-task into a 0700 ephemeral HOME) |
| `READONLY_BASE_DIR` | `/var/lib/forge/ro` | Root-owned, mode-0711 base dir holding the disposable read-only copies (never `/tmp`). Created at startup |
| `READONLY_PREP_TIMEOUT_MS` | `120000` | Wall-clock cap on read-only copy preparation before the prep worker is killed |
| `TASK_TIMEOUT_MS` | `3600000` | Wall-clock cap on a single **read-only** task (`0` disables). Writable tasks are never capped |
| `KILL_GRACE_MS` | `10000` | Grace period between `SIGTERM` and `SIGKILL` when terminating a task |
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
   The real repo is only ever *read*. **All of this preparation — the clone, every
   read of the real working tree, and every overlay write — runs in a child process
   that has already dropped to the read-only account**, never as root, so a hostile
   working tree cannot trick a privileged process into reading host files or writing
   outside the copy. Each overlay refuses to follow a symlinked parent, opens source
   and destination with `O_NOFOLLOW`, skips non-regular files (FIFOs/sockets/devices),
   and enforces per-file and total size caps. Every git invocation — in the real repo
   during prep **and** in the copy during the post-run report — runs with a fixed PATH,
   a minimal env (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
   `GIT_TERMINAL_PROMPT=0`) and a block of hardening flags that neutralise every git
   config vector that can execute a program: `core.fsmonitor=false`,
   `core.hooksPath=/dev/null`, `core.untrackedCache=false`, `log.showSignature=false`,
   `gpg.program=false`, `diff.external=` (empty), each discovered `filter.<n>.{clean,
   smudge,process}` blanked with `required=false`, and `--no-textconv --no-ext-diff` on
   diffs. **This narrows the attack surface; it is not the guarantee.** The guarantee
   is structural: the preparation and report run unprivileged (dropped to the read-only
   account) inside a disposable copy, so even a git-config vector we did not anticipate
   executes as a credential-less account that cannot reach the real repo or any remote.
2. **The copy has nowhere to push.** Every remote is removed from the copy, so
   `git push`/`fetch` have no target.
3. **The agent runs as a separate, credential-less account.** Set
   `READONLY_RUN_USER` to a dedicated OS account (e.g. `forge-ro`) that owns nothing
   and holds no SSH keys, `gh` login, or `~/.git-credentials`. The copy is `chown`ed
   to that account and the process runs under its uid/gid. This account must be
   **distinct** from `CLAUDE_RUN_USER`/`CODEX_RUN_USER` (the writable run accounts) in
   **both uid and gid** — it needs its own dedicated primary group, because a shared
   group would let it read the writable account's group-readable repos and credentials.
   It must also **not own the repo or its `.git`** it reads. If the read-only uid or
   gid equals a writable run account's uid/gid, is 0, or the account owns the repo or
   `.git`, read-only is refused and the task fails closed. A writable run account whose
   name does not resolve is treated as a *potential* collision — isolation is refused
   rather than assumed.
4. **The environment is a per-task, minimal allowlist rooted at an ephemeral HOME.**
   The read-only process gets only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `TERM`,
   and the provider's auth dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`). Inherited tokens
   such as `GH_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
   `OPENAI_API_KEY`, and `AWS_*` are stripped. `HOME` is a **fresh per-task directory
   inside the disposable copy's tree**, discarded with it — so one read-only task
   cannot plant a `~/.gitconfig` / `~/.config/...` that the next task would read. The
   provider's auth is **copied per task** into that ephemeral HOME at mode `0700` owned
   by the read-only account (see below), never shared live between tasks.
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
7. **Whole-process-tree teardown + wall-clock cap.** Each read-only task gets its own
   cgroup v2 node (when the runner runs as root on a cgroup-v2 host) holding the prep
   worker, the agent, the report worker, and everything they fork. Cancel/close/timeout
   writes `cgroup.kill`, reaping the **entire tree in one shot** — including a child
   that called `setsid()` to escape the process group. Where a cgroup can't be created
   (non-root / no cgroup v2) it falls back to a process-group `SIGTERM`→`SIGKILL`
   (grace `KILL_GRACE_MS`, default 10s). The agent leader exiting is treated as the
   authoritative "done" signal, so a surviving child holding stdout open can no longer
   keep a finished task "running" forever. A cancel that arrives **during copy
   preparation** (up to `READONLY_PREP_TIMEOUT_MS`, default 2 min) kills the prep
   worker and aborts before the agent starts. Only read-only tasks are wall-clock
   capped (`TASK_TIMEOUT_MS`, default 60 min; `0` disables it); **writable tasks are
   never wall-clock capped** — their behaviour is exactly as before. The disposable
   copy's contents are then deleted *as the read-only account* with
   `rm -rf --one-file-system` (so root never recurses a tree the account could swap for
   a symlink mid-delete), and root only `rmdir`s the empty top dir. The copies live
   under a root-owned, mode-`0711` base dir (`READONLY_BASE_DIR`, default
   `/var/lib/forge/ro`) — **never `/tmp`**, which a local user could race. On startup
   the runner sweeps copy dirs and task cgroups orphaned by a previous crash/restart,
   touching only entries owned by root or the read-only account.

After the run, the runner records an informational report of what changed **inside
the copy** (`git status --porcelain=v2 --ignored` plus any commits the agent made);
the real repo and its remotes are never inspected or modified.

### What read-only does NOT guarantee

- **Network egress is not blocked.** The agent can still make outbound network calls
  (it just has no credentials and no git remotes). If you need egress isolation, run
  the runner inside a network-restricted container/namespace.
- **The read-only account can still *read* whatever its uid is allowed to read.** That
  includes:
  - **The provider's own OAuth tokens.** The agent needs valid auth to run, so a
    *copy* of the provider's credentials is necessarily reachable by the running agent.
    The pristine source (`READONLY_CLAUDE_CONFIG_DIR` / `READONLY_CODEX_HOME`, or the
    account's `~/.claude` / `~/.codex`) should be **root-owned and mode `0700`** — not
    world- or group-readable — so only root can read it at rest; each task gets its own
    `0700` copy inside its ephemeral HOME, which is destroyed when the task ends. Keep
    the source `0700` so neither other local users nor a prior task's leftovers can
    read it, and so a task cannot *tamper* with it to poison the next run.
  - **Any repo the account is allowed to clone**, plus anything world-readable on the
    host. The read-only account must be able to read each `ALLOWED_REPO_PATH` — grant
    that with an ACL (`setfacl -R -m u:forge-ro:rX <path>`) rather than a **shared
    group**, which would also hand the read-only account the writable run account's
    other group-readable files. Keep other local users out (`chmod -R o-rx <path>`),
    and never leave plaintext secrets in tracked/ignored repo files.
- It is not a sandbox for arbitrary host damage outside the copy — it relies on the
  `READONLY_RUN_USER` account owning nothing the agent should be able to touch, and on
  that account having its own dedicated uid **and** gid.

### One-time host setup

Create the isolated account and give it its own provider auth (run once, as root):

```bash
# 1. A credential-less account that owns nothing, with its OWN dedicated primary group
#    (a shared group would leak the writable account's group-readable files).
useradd --system --create-home --user-group --shell /usr/sbin/nologin forge-ro

# 2. Isolated auth dirs for the read-only account (owned by it for the first login).
install -d -o forge-ro -g forge-ro /etc/forge-ro/claude /etc/forge-ro/codex

# 3. Log that account into claude / codex once, writing into those dirs:
sudo -u forge-ro CLAUDE_CONFIG_DIR=/etc/forge-ro/claude claude   # /login
sudo -u forge-ro CODEX_HOME=/etc/forge-ro/codex codex login

# 4. LOCK the auth source: root-owned and mode 0700 — NOT world/group readable. The
#    runner copies it per-task into a throwaway 0700 HOME, so the agent never reads
#    this source directly and cannot tamper with it to poison the next task:
chown -R root:root /etc/forge-ro/claude /etc/forge-ro/codex
chmod -R u=rwX,go= /etc/forge-ro/claude /etc/forge-ro/codex

# 5. Let forge-ro READ the repos it may clone — via an ACL, not a shared group (a
#    shared group would also expose the writable account's other group-readable files):
setfacl -R -m u:forge-ro:rX /home/forge/repos        # each ALLOWED_REPO_PATH
setfacl -R -d -m u:forge-ro:rX /home/forge/repos     # default ACL for new files
chmod -R o-rx /home/forge/repos                       # keep OTHER local users out

# 6. Point the runner at it (in apps/runner/.env):
#    READONLY_RUN_USER=forge-ro            # MUST differ (uid AND gid) from CLAUDE_RUN_USER/CODEX_RUN_USER
#    READONLY_CLAUDE_CONFIG_DIR=/etc/forge-ro/claude
#    READONLY_CODEX_HOME=/etc/forge-ro/codex
#    READONLY_BASE_DIR=/var/lib/forge/ro   # root-owned 0711; the runner creates it
```

`scripts/setup.sh` automates steps 1, 2, and 4 when you pass `READONLY_RUN_USER`
(it leaves the dirs writable for the first login, then locks them to root-owned `0700`
on a re-run once they contain credentials). The runner must itself start as root for
the uid/gid drop, the per-task auth copy, and `chown` to work.

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
