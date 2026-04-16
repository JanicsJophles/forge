# Forge · CLAUDE.md

## What this project is

Forge is a self-hosted Claude Code agent runner. Send it a repo path and a prompt — it runs the Claude Code CLI, streams output back via SSE in real time, and optionally commits the result. Run coding agents on your server while your laptop is closed.

## Tech stack

- Node.js 20+ TypeScript (tsx dev, tsc prod)
- Express
- `child_process.spawn` for streaming claude CLI output
- SSE (Server-Sent Events) for real-time log streaming
- better-sqlite3 for local task storage
- PM2 for production process management

## Directory structure

```
forge/
├── apps/
│   └── runner/              # the core service
│       ├── src/
│       │   ├── index.ts     # Express app entrypoint
│       │   ├── config.ts    # env-based configuration
│       │   ├── db/          # SQLite schema + queries
│       │   ├── agent/       # runner, stream, git helpers
│       │   └── routes/      # tasks, repos, health endpoints
│       ├── Dockerfile
│       ├── pm2.config.cjs
│       └── .env.example
├── packages/
│   └── shared/              # shared TypeScript types
│       └── src/types.ts
├── scripts/
│   └── setup.sh             # server setup (Node, PM2, Claude CLI)
└── docker-compose.yml
```

## Key design decisions

- **spawn, not execSync** — claude output must stream line-by-line to SSE clients
- **500ms flush buffer** — avoids hammering SSE/DB on every stdout chunk
- **No queue** — returns 429 when MAX_CONCURRENT_TASKS is reached
- **Repo allowlist** — ALLOWED_REPO_PATHS prevents arbitrary filesystem access
- **git pull before run** — auto-pulls if upstream is configured, no-op otherwise
- **git add -u on commit** — only stages tracked file modifications, not untracked files

## API routes

```
POST /tasks          → create + start task, returns { taskId }
GET  /tasks          → last 20 tasks
GET  /tasks/:id      → single task
GET  /tasks/:id/stream → SSE stream (catch-up + live)
DELETE /tasks/:id    → SIGTERM active task
GET  /repos          → list git repos in ALLOWED_REPO_PATHS
GET  /health         → { status: 'ok', activeTasks: N }
```

## Development

```bash
npm install
cp apps/runner/.env.example apps/runner/.env  # edit ALLOWED_REPO_PATHS
npm run dev
```

## Build & run

```bash
npm run build
node apps/runner/dist/index.js
```
