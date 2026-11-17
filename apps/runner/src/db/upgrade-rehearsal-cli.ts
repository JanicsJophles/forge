// CLI for scripts/rehearse-upgrade.sh. Takes a scratch directory holding a COPY
// of forge.db; never point it at a directory a runner is using.
import { rehearseUpgrade } from './upgrade-rehearsal.js'

const dataDir = process.argv[2]
if (!dataDir) {
  console.error('usage: upgrade-rehearsal-cli <scratch-dir-containing-a-copy-of-forge.db>')
  process.exit(2)
}

const result = rehearseUpgrade(dataDir)
const megabytes = (result.databaseBytes / 1048576).toFixed(1)
console.log(`[rehearsal] database: ${megabytes} MB, user_version ${result.baseline.userVersion} -> ${result.final.userVersion}`)
for (const [table, snapshot] of Object.entries(result.baseline.tables)) {
  console.log(`[rehearsal] ${table}: ${snapshot.rows} rows before, ${result.final.tables[table]?.rows ?? 'MISSING'} after`)
}
console.log(`[rehearsal] columns added: ${result.columnsAdded.join(', ') || 'none'}`)
for (const entry of result.schemaAdded) console.log(`[rehearsal] schema + ${entry}`)
for (const entry of result.schemaRemoved) console.log(`[rehearsal] schema - ${entry}`)
console.log(`[rehearsal] tasks reconciled from queued/running to failed: ${result.reconciledTasks}`)
result.starts.forEach((start, index) => console.log(
  `[rehearsal] start ${index + 1}: exit ${start.exitCode}, bootstrap ${start.probe?.bootstrapMs ?? '?'} ms`))
for (const entry of result.checks) console.log(`[rehearsal] ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name} (${entry.detail})`)
console.log(result.ok ? '[rehearsal] PASS' : '[rehearsal] FAIL')
process.exit(result.ok ? 0 : 1)
