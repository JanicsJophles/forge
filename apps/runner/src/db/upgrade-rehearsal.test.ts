import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { evaluateUpgrade, rehearseUpgrade, runStart, snapshotDatabase } from './upgrade-rehearsal.js'

// The schema of the production database as of 2026-11-17 (runner build e85607b):
// tasks was created with eleven columns and then grew provider and auto_commit
// through ALTER TABLE; the agent tables come from that build's agent-state.ts.
// PRAGMA user_version is 0 and there is no migrations table.
const LIVE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    repo         TEXT NOT NULL,
    branch       TEXT NOT NULL,
    prompt       TEXT NOT NULL,
    status       TEXT DEFAULT 'queued',
    log          TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now')),
    started_at   TEXT,
    completed_at TEXT,
    error_message TEXT,
    commit_sha   TEXT
  );
  ALTER TABLE tasks ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
  ALTER TABLE tasks ADD COLUMN auto_commit INTEGER;
  CREATE TABLE IF NOT EXISTS agent_state (
    agent_id      TEXT PRIMARY KEY,
    agent_type    TEXT NOT NULL,
    repo          TEXT,
    branch        TEXT,
    intent        TEXT,
    files_touched TEXT,
    ticket        TEXT,
    status        TEXT,
    expires_at    TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    metadata      TEXT
  );
  CREATE INDEX IF NOT EXISTS agent_state_expires_idx ON agent_state(expires_at);
  CREATE INDEX IF NOT EXISTS agent_state_repo_idx    ON agent_state(repo);
  CREATE INDEX IF NOT EXISTS agent_state_ticket_idx  ON agent_state(ticket);
  CREATE TABLE IF NOT EXISTS agent_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT NOT NULL,
    repo        TEXT,
    ticket      TEXT,
    pr_number   INTEGER,
    agent_id    TEXT,
    details     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS agent_events_created_idx ON agent_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS agent_events_repo_idx    ON agent_events(repo);
  CREATE INDEX IF NOT EXISTS agent_events_ticket_idx  ON agent_events(ticket);
  CREATE INDEX IF NOT EXISTS agent_events_type_idx    ON agent_events(event_type);
`
const LIVE_TASK_COLUMNS = ['id', 'repo', 'branch', 'prompt', 'status', 'log', 'created_at', 'started_at',
  'completed_at', 'error_message', 'commit_sha', 'provider', 'auto_commit']
const TABLES = ['tasks', 'agent_state', 'agent_events']

type Row = Record<string, unknown>

function liveDatabase(t: TestContext): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'forge-upgrade-rehearsal-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const db = new Database(path.join(dataDir, 'forge.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(LIVE_SCHEMA)
  const task = db.prepare(`INSERT INTO tasks (id, repo, branch, prompt, status, log, created_at, started_at,
    completed_at, error_message, commit_sha, provider, auto_commit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const repo = '/opt/repos/brain'
  task.run('t-completed', repo, 'develop', 'add the widget', 'completed', 'done ✓ café\n',
    '2026-10-19 12:00:00', '2026-10-19 12:00:01', '2026-10-19 12:05:00', null, 'abc1234', 'claude', 1)
  task.run('t-failed', repo, 'fleet/next', 'fix the gate', 'failed', 'bwrap: Failed to make / slave\n',
    '2026-11-05 06:06:38', '2026-11-05 06:06:39', '2026-11-05 06:07:00', 'agent exited with code 1', null, 'codex', 0)
  // ISO timestamps and a NULL auto_commit: written by callers that set created_at themselves.
  task.run('t-iso', repo, 'main', 'iso timestamps', 'completed', 'ok\n',
    '2026-11-10T08:30:00.000Z', '2026-11-10T08:30:01.000Z', '2026-11-10T08:31:00.000Z', null, 'def5678', 'claude', null)
  task.run('t-null-log', repo, 'main', 'never produced output', 'failed', null,
    '2026-11-11 09:00:00', null, '2026-11-11 09:00:02', 'spawn failed', null, 'claude', null)
  // Larger than every log tail projection (262144 bytes).
  task.run('t-big-log', repo, 'main', 'long transcript', 'completed', 'line of transcript é\n'.repeat(20000),
    '2026-11-12 10:00:00', '2026-11-12 10:00:01', '2026-11-12 11:00:00', null, '0123abc', 'codex', 1)
  // Left behind by the process that was running when the old build stopped.
  task.run('t-running', repo, 'develop', 'interrupted mid-run', 'running', 'partial\n',
    '2026-11-17 01:00:00', '2026-11-17 01:00:01', null, null, null, 'codex', 0)
  task.run('t-queued', repo, 'develop', 'never started', 'queued', '',
    '2026-11-17 01:01:00', null, null, null, null, 'claude', null)

  const agent = db.prepare(`INSERT INTO agent_state (agent_id, agent_type, repo, branch, intent, files_touched,
    ticket, status, expires_at, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  agent.run('local-1', 'claude-code', 'brain', 'feat/x', 'verifying the gate', '["a.ts","b.ts"]', 'RAC-378',
    'verified', '2099-01-01 00:00:00', '2026-11-16 10:00:00', '2026-11-16 11:00:00', '{"pr":25}')
  agent.run('forge-7', 'forge', 'forge', 'fleet/next', 'editing provider', null, null,
    'editing', '2099-01-01 00:00:00', '2026-11-16 10:00:00', '2026-11-16 12:00:00', null)
  agent.run('stale-3', 'codex', null, null, null, null, null,
    'blocked: waiting on review', '2026-01-01 00:00:00', '2025-12-31 10:00:00', '2025-12-31 11:00:00', 'not json')
  agent.run('quiet-9', 'unknown', null, null, null, null, null,
    null, '2099-01-01 00:00:00', '2026-11-16 10:00:00', '2026-11-16 10:30:00', null)

  const event = db.prepare(`INSERT INTO agent_events (event_type, repo, ticket, pr_number, agent_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
  event.run('agent_started', 'brain', 'RAC-378', null, 'local-1', '{"note":"start"}', '2026-11-16 10:00:00')
  event.run('pr_opened', 'forge', null, 25, 'forge-7', '{"url":"https://example.invalid/pr/25"}', '2026-11-16 10:30:00')
  event.run('pr_merged', 'forge', null, 25, null, null, '2026-11-16 11:00:00')
  assert.equal(db.pragma('user_version', { simple: true }), 0)
  db.close()
  return dataDir
}

function readAll(dataDir: string, columns: Record<string, string[]>): Record<string, Row[]> {
  const db = new Database(path.join(dataDir, 'forge.db'), { fileMustExist: true })
  try {
    return Object.fromEntries(TABLES.map(table => [table,
      db.prepare(`SELECT ${columns[table].join(', ')} FROM ${table} ORDER BY rowid`).all() as Row[]]))
  } finally {
    db.close()
  }
}

function columnsOf(dataDir: string): Record<string, string[]> {
  const db = new Database(path.join(dataDir, 'forge.db'), { fileMustExist: true })
  try {
    return Object.fromEntries(TABLES.map(table => [table,
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name)]))
  } finally {
    db.close()
  }
}

test('a database with the live schema upgrades cleanly, keeps every row and is idempotent on a second start', t => {
  const dataDir = liveDatabase(t)
  const liveColumns = columnsOf(dataDir)
  assert.deepEqual(liveColumns.tasks, LIVE_TASK_COLUMNS)
  const before = readAll(dataDir, liveColumns)
  const baseline = snapshotDatabase(dataDir)
  assert.deepEqual(baseline.liveTaskIds, ['t-queued', 't-running'])

  const firstStart = runStart(dataDir)
  assert.equal(firstStart.exitCode, 0, firstStart.output)
  const afterFirst = readAll(dataDir, liveColumns)

  // Every pre-upgrade row is still there with identical content. Checked row by
  // row here, independently of the digests the rehearsal itself relies on.
  assert.deepEqual(afterFirst.agent_state, before.agent_state)
  assert.deepEqual(afterFirst.agent_events, before.agent_events)
  assert.equal(afterFirst.tasks.length, before.tasks.length)
  for (const [index, row] of before.tasks.entries()) {
    const upgraded = afterFirst.tasks[index]
    if (row.status !== 'queued' && row.status !== 'running') {
      assert.deepEqual(upgraded, row)
      continue
    }
    // The one intended change: tasks orphaned by the old process are failed.
    assert.equal(upgraded.status, 'failed')
    assert.equal(upgraded.error_message, 'agent process killed by runner restart')
    assert.match(String(upgraded.completed_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.deepEqual({ ...upgraded, status: 0, error_message: 0, completed_at: 0 },
      { ...row, status: 0, error_message: 0, completed_at: 0 })
  }
  assert.deepEqual(afterFirst.agent_state.map(row => row.status),
    ['verified', 'editing', 'blocked: waiting on review', null])

  // The new schema is in place: one added column, the chronological indexes.
  const upgradedColumns = columnsOf(dataDir)
  assert.deepEqual(upgradedColumns.tasks, [...LIVE_TASK_COLUMNS, 'model'])
  assert.deepEqual(upgradedColumns.agent_state, liveColumns.agent_state)
  assert.deepEqual(upgradedColumns.agent_events, liveColumns.agent_events)
  const first = snapshotDatabase(dataDir, baseline)
  for (const index of ['tasks_created_idx', 'tasks_chronological_idx', 'tasks_live_chronological_idx']) {
    assert.ok(first.schema.some(entry => entry.startsWith(`index ${index} on tasks`)), `${index} missing`)
  }
  assert.equal(first.userVersion, 0)
  assert.deepEqual(first.quickCheck, ['ok'])

  // The new code reads the old rows through its query layer.
  assert.deepEqual(firstStart.probe && { ...firstStart.probe, bootstrapMs: 0 }, {
    bootstrapMs: 0, listedTasks: 7, readTasks: 7, activeTasks: 0, agentRows: 4,
    agentStatuses: ['blocked: waiting on review', 'editing', null, 'verified'], eventRows: 3,
  })

  // Second start: nothing at all changes, including the rows reconciled above.
  const allColumnsAfterFirst = readAll(dataDir, upgradedColumns)
  const secondStart = runStart(dataDir)
  assert.equal(secondStart.exitCode, 0, secondStart.output)
  assert.deepEqual(readAll(dataDir, upgradedColumns), allColumnsAfterFirst)
  const second = snapshotDatabase(dataDir, baseline)
  assert.deepEqual(second, first)

  const checks = evaluateUpgrade(baseline, first, second, [firstStart, secondStart])
  assert.deepEqual(checks.filter(check => !check.ok), [])
})

test('rehearseUpgrade passes on the live schema and reports what the upgrade changed', t => {
  const result = rehearseUpgrade(liveDatabase(t))
  assert.deepEqual(result.checks.filter(check => !check.ok), [])
  assert.equal(result.ok, true)
  assert.deepEqual(result.columnsAdded, ['tasks.model'])
  assert.equal(result.reconciledTasks, 2)
  assert.deepEqual(result.schemaRemoved.filter(entry => !entry.startsWith('table tasks ')), [])
  assert.deepEqual(result.starts.map(start => start.exitCode), [0, 0])
})

test('the rehearsal fails when an upgrade loses or rewrites data', t => {
  const dataDir = liveDatabase(t)
  const baseline = snapshotDatabase(dataDir)
  const start = runStart(dataDir)
  const first = snapshotDatabase(dataDir, baseline)
  const failing = (name: string, second = first, starts = [start, start], from = first) =>
    evaluateUpgrade(baseline, from, second, starts).filter(check => !check.ok).map(check => check.name).includes(name)
  assert.equal(evaluateUpgrade(baseline, first, first, [start, start]).every(check => check.ok), true)

  const tamper = (sql: string) => {
    const db = new Database(path.join(dataDir, 'forge.db'), { fileMustExist: true })
    try { db.exec(sql) } finally { db.close() }
    return snapshotDatabase(dataDir, baseline)
  }
  // A rewritten value in a pre-upgrade column, with the row count intact.
  const rewritten = tamper("UPDATE tasks SET log = 'truncated' WHERE id = 't-big-log'")
  assert.equal(failing('tasks: row content unchanged', rewritten, [start, start], rewritten), true)
  assert.equal(failing('tasks: row count unchanged', rewritten, [start, start], rewritten), false)
  assert.equal(failing('second start: no row changes', rewritten), true)
  // A lost row, a normalized free-form status, a dropped column.
  const lost = tamper("DELETE FROM agent_events WHERE event_type = 'pr_merged'")
  assert.equal(failing('agent_events: row count unchanged', lost, [start, start], lost), true)
  const normalized = tamper("UPDATE agent_state SET status = 'unknown' WHERE status = 'verified'")
  assert.equal(failing('agent_state: free-form statuses preserved', normalized, [start, start], normalized), true)
  assert.equal(failing('agent_state: row content unchanged', normalized, [start, start], normalized), true)
  const dropped = tamper('ALTER TABLE tasks DROP COLUMN commit_sha')
  assert.equal(failing('tasks: every column survives', dropped, [start, start], dropped), true)
  assert.equal(failing('second start: schema unchanged', dropped), true)
  // A start that crashes is a failure even if the data is intact.
  assert.equal(failing('start 1 exits 0 and reads old rows through the query layer', first,
    [{ exitCode: 1, output: 'boom' }, start]), true)
})

test('scripts/rehearse-upgrade.sh rehearses on its own copy and never touches the file it is given', t => {
  const dataDir = liveDatabase(t)
  const source = path.join(dataDir, 'forge.db')
  // Fold the WAL into the main file so the bytes on disk are the whole database.
  const db = new Database(source, { fileMustExist: true })
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.pragma('journal_mode = DELETE')
  db.close()
  const sha = () => createHash('sha256').update(readFileSync(source)).digest('hex')
  const before = sha()
  const scratchRoot = mkdtempSync(path.join(tmpdir(), 'forge-upgrade-script-'))
  t.after(() => rmSync(scratchRoot, { recursive: true, force: true }))
  const script = fileURLToPath(new URL('../../../../scripts/rehearse-upgrade.sh', import.meta.url))
  const env = { ...process.env, TMPDIR: scratchRoot }
  delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT

  const run = spawnSync('bash', [script, source], { env, encoding: 'utf8', timeout: 120_000 })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /\[rehearsal\] columns added: tasks\.model/)
  assert.match(run.stdout, /\[rehearsal\] PASS/)
  assert.match(run.stdout, /\[rehearsal\] source file untouched/)
  assert.equal(sha(), before, 'the database passed to the script must be byte-identical afterwards')
  assert.deepEqual(readdirSync(dataDir), ['forge.db'], 'no WAL or journal may appear next to the source')
  // tsx keeps its own cache directory under TMPDIR; only the scratch copy matters.
  assert.deepEqual(readdirSync(scratchRoot).filter(name => name.startsWith('forge-upgrade-rehearsal.')), [],
    'the scratch copy is removed')

  const usage = spawnSync('bash', [script], { env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(usage.status, 2)
  const missing = spawnSync('bash', [script, path.join(dataDir, 'absent.db')], { env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(missing.status, 2)
})
