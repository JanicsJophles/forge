// Upgrade rehearsal: start the current runner code against a database written
// by an older build and prove that nothing was lost.
//
// The directory passed in is MUTATED (that is the point), so callers hand over
// a scratch copy: scripts/rehearse-upgrade.sh makes one from a real database,
// and the test builds a fixture with the schema that is live in production.
import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Shared with upgrade-start.ts, the child entry that performs one start.
export const PROBE_MARKER = 'REHEARSAL_PROBE '
export const PROBE_TASK_LIMIT = 20
export const PROBE_EVENT_LIMIT = 1000

export interface StartProbe {
  bootstrapMs: number
  listedTasks: number
  readTasks: number
  activeTasks: number
  agentRows: number
  agentStatuses: (string | null)[]
  eventRows: number
}

// Startup turns tasks left queued/running by the previous process into failed
// rows. These three columns of those rows are the only data allowed to change.
const RECONCILED_COLUMNS = ['status', 'error_message', 'completed_at']

export interface TableSnapshot {
  columns: string[]
  rows: number
  /** Content of the baseline columns, with reconciled task fields masked. */
  digest: string
  /** Content of every current column, unmasked. Compared between two starts. */
  fullDigest: string
}

export interface Snapshot {
  userVersion: number
  schema: string[]
  tables: Record<string, TableSnapshot>
  liveTaskIds: string[]
  taskStatuses: Record<string, number>
  agentStatuses: (string | null)[]
  quickCheck: string[]
  foreignKeyViolations: number
}

export interface Check { name: string; ok: boolean; detail: string }

export interface StartResult { exitCode: number | null; probe?: StartProbe; output: string }

export interface RehearsalResult {
  ok: boolean
  checks: Check[]
  databaseBytes: number
  columnsAdded: string[]
  schemaAdded: string[]
  schemaRemoved: string[]
  reconciledTasks: number
  starts: StartResult[]
  baseline: Snapshot
  final: Snapshot
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`

function encode(value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}n`
  if (Buffer.isBuffer(value)) return `blob:${value.toString('base64')}`
  return value
}

function digestRows(db: Database.Database, table: string, columns: string[], masked: Set<string>): string {
  const hash = createHash('sha256')
  const idIndex = columns.indexOf('id')
  const maskIndexes = table === 'tasks' && idIndex >= 0
    ? RECONCILED_COLUMNS.map(column => columns.indexOf(column)).filter(index => index >= 0)
    : []
  const statement = db.prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(table)} ORDER BY rowid`)
  for (const row of statement.safeIntegers(true).raw().iterate() as IterableIterator<unknown[]>) {
    if (maskIndexes.length && masked.has(String(row[idIndex]))) {
      for (const index of maskIndexes) row[index] = '<reconciled>'
    }
    hash.update(JSON.stringify(row.map(encode)))
    hash.update('\n')
  }
  return hash.digest('hex')
}

/**
 * Read-only description of forge.db in `dataDir`. With a `baseline`, each
 * table's `digest` covers the baseline's columns and masks the baseline's live
 * tasks, so it is directly comparable to the baseline's own digest.
 */
export function snapshotDatabase(dataDir: string, baseline?: Snapshot): Snapshot {
  const db = new Database(path.join(dataDir, 'forge.db'), { fileMustExist: true })
  try {
    const tableNames = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[]).map(row => row.name)
    const columnsOf = (table: string) =>
      (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[]).map(column => column.name)
    const hasTasks = tableNames.includes('tasks')
    const liveTaskIds = hasTasks
      ? (db.prepare("SELECT id FROM tasks WHERE status IN ('queued', 'running') ORDER BY id").all() as { id: string }[])
        .map(row => String(row.id))
      : []
    const masked = new Set(baseline ? baseline.liveTaskIds : liveTaskIds)
    const tables: Record<string, TableSnapshot> = {}
    for (const table of tableNames) {
      const columns = columnsOf(table)
      const wanted = baseline?.tables[table]?.columns ?? columns
      const rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as { n: number }).n
      tables[table] = {
        columns,
        rows,
        digest: wanted.every(column => columns.includes(column))
          ? digestRows(db, table, wanted, masked) : 'baseline columns missing',
        fullDigest: digestRows(db, table, columns, new Set()),
      }
    }
    const taskStatuses: Record<string, number> = {}
    if (hasTasks) {
      for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as { status: string | null; n: number }[]) {
        taskStatuses[String(row.status)] = row.n
      }
    }
    const agentStatuses = tableNames.includes('agent_state')
      ? (db.prepare('SELECT DISTINCT status FROM agent_state').all() as { status: string | null }[])
        .map(row => row.status).sort((a, b) => String(a).localeCompare(String(b)))
      : []
    return {
      userVersion: db.pragma('user_version', { simple: true }) as number,
      schema: (db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      ).all() as { type: string; name: string; tbl_name: string; sql: string | null }[])
        .map(row => `${row.type} ${row.name} on ${row.tbl_name}: ${(row.sql ?? '').replace(/\s+/g, ' ').trim()}`),
      tables,
      liveTaskIds,
      taskStatuses,
      agentStatuses,
      quickCheck: (db.pragma('quick_check') as { quick_check: string }[]).map(row => row.quick_check),
      foreignKeyViolations: (db.pragma('foreign_key_check') as unknown[]).length,
    }
  } finally {
    db.close()
  }
}

/** Run one real start (schema bootstrap plus read probes) in a child process. */
export function runStart(dataDir: string): StartResult {
  const self = fileURLToPath(import.meta.url)
  const fromSource = self.endsWith('.ts')
  const entry = path.join(path.dirname(self), fromSource ? 'upgrade-start.ts' : 'upgrade-start.js')
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, TASK_RETENTION_DAYS: '0' }
  // Retention is forced off: it deletes old rows by design and would hide a real loss.
  delete env.NODE_TEST_CONTEXT
  const child = spawnSync(process.execPath, [...(fromSource ? ['--import', 'tsx'] : []), entry], {
    cwd: path.resolve(path.dirname(self), '..', '..'), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}${child.error ? String(child.error) : ''}`
  const line = (child.stdout ?? '').split('\n').find(candidate => candidate.startsWith(PROBE_MARKER))
  return {
    exitCode: child.status,
    probe: line ? JSON.parse(line.slice(PROBE_MARKER.length)) as StartProbe : undefined,
    output,
  }
}

/** Pure comparison, separate from the starts so a known loss can be fed to it in tests. */
export function evaluateUpgrade(
  baseline: Snapshot, first: Snapshot, second: Snapshot, starts: StartResult[],
): Check[] {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

  starts.forEach((start, index) => check(
    `start ${index + 1} exits 0 and reads old rows through the query layer`,
    start.exitCode === 0 && start.probe !== undefined,
    start.exitCode === 0 && start.probe ? `bootstrap ${start.probe.bootstrapMs} ms` : `exit ${start.exitCode}: ${start.output.trim().slice(-2000)}`,
  ))
  for (const [table, before] of Object.entries(baseline.tables)) {
    const after = first.tables[table]
    check(`${table}: table survives`, after !== undefined, after ? 'present' : 'dropped')
    if (!after) continue
    const missing = before.columns.filter(column => !after.columns.includes(column))
    check(`${table}: every column survives`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${before.columns.length} columns`)
    check(`${table}: row count unchanged`, after.rows === before.rows, `${before.rows} before, ${after.rows} after`)
    check(`${table}: row content unchanged`, after.digest === before.digest,
      after.digest === before.digest ? 'sha256 of pre-upgrade columns matches' : 'sha256 of pre-upgrade columns differs')
  }
  const statusesAfter = (status: string) => first.taskStatuses[status] ?? 0
  check('tasks: rows left queued/running are reconciled to failed, nothing else',
    first.liveTaskIds.length === 0
      && statusesAfter('failed') === (baseline.taskStatuses.failed ?? 0) + baseline.liveTaskIds.length
      && Object.keys(baseline.taskStatuses).filter(status => !['queued', 'running', 'failed'].includes(status))
        .every(status => first.taskStatuses[status] === baseline.taskStatuses[status]),
    `${baseline.liveTaskIds.length} reconciled; before ${JSON.stringify(baseline.taskStatuses)}, after ${JSON.stringify(first.taskStatuses)}`)
  check('agent_state: free-form statuses preserved', same(first.agentStatuses, baseline.agentStatuses),
    `before ${JSON.stringify(baseline.agentStatuses)}, after ${JSON.stringify(first.agentStatuses)}`)
  check('integrity: quick_check ok and no foreign key violations',
    same(first.quickCheck, ['ok']) && first.foreignKeyViolations === 0,
    `quick_check ${first.quickCheck.join('; ')}; ${first.foreignKeyViolations} foreign key violations`)

  const probe = starts[0]?.probe
  if (probe) {
    const tasks = baseline.tables.tasks?.rows ?? 0
    const agents = baseline.tables.agent_state?.rows ?? 0
    const events = baseline.tables.agent_events?.rows ?? 0
    check('query layer returns the pre-upgrade rows',
      probe.listedTasks === Math.min(PROBE_TASK_LIMIT, tasks) && probe.readTasks === probe.listedTasks
        && probe.agentRows === agents && same(probe.agentStatuses, baseline.agentStatuses)
        && probe.eventRows === Math.min(PROBE_EVENT_LIMIT, events) && probe.activeTasks === 0,
      `tasks ${probe.listedTasks}/${Math.min(PROBE_TASK_LIMIT, tasks)}, agents ${probe.agentRows}/${agents}, `
        + `events ${probe.eventRows}/${Math.min(PROBE_EVENT_LIMIT, events)}, active ${probe.activeTasks}`)
  }

  check('second start: schema unchanged', same(second.schema, first.schema) && second.userVersion === first.userVersion,
    same(second.schema, first.schema) ? `${second.schema.length} schema objects, user_version ${second.userVersion}` : 'schema differs between starts')
  const drifted = Object.keys(first.tables).filter(table =>
    second.tables[table]?.rows !== first.tables[table].rows || second.tables[table]?.fullDigest !== first.tables[table].fullDigest)
  check('second start: no row changes', drifted.length === 0, drifted.length ? `changed: ${drifted.join(', ')}` : 'every table byte-identical by sha256')
  check('second start: integrity', same(second.quickCheck, ['ok']) && second.foreignKeyViolations === 0, `quick_check ${second.quickCheck.join('; ')}`)
  return checks
}

/** Start the current code twice against `dataDir`/forge.db and report what changed. */
export function rehearseUpgrade(dataDir: string): RehearsalResult {
  const databaseBytes = statSync(path.join(dataDir, 'forge.db')).size
  const baseline = snapshotDatabase(dataDir)
  const starts = [runStart(dataDir)]
  const first = snapshotDatabase(dataDir, baseline)
  starts.push(runStart(dataDir))
  const second = snapshotDatabase(dataDir, baseline)
  const checks = evaluateUpgrade(baseline, first, second, starts)
  return {
    ok: checks.every(entry => entry.ok),
    checks,
    databaseBytes,
    columnsAdded: Object.entries(second.tables).flatMap(([table, snapshot]) =>
      snapshot.columns.filter(column => !baseline.tables[table]?.columns.includes(column)).map(column => `${table}.${column}`)),
    schemaAdded: second.schema.filter(entry => !baseline.schema.includes(entry)),
    schemaRemoved: baseline.schema.filter(entry => !second.schema.includes(entry)),
    reconciledTasks: baseline.liveTaskIds.length,
    starts,
    baseline,
    final: second,
  }
}
