import type Database from 'better-sqlite3'

export function migrateVerification(db: Database.Database) {
  // Numbered migrations are atomic and recorded only after successful upgrades.
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY)')
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM _migrations WHERE id = ?').get('001_verification')) return
    const columns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
    for (const column of ['options', 'verification']) {
      if (!columns.some(c => c.name === column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`)
    }
    db.prepare('INSERT INTO _migrations (id) VALUES (?)').run('001_verification')
  })()

}
