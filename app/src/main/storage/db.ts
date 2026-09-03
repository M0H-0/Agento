import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Plain Node only — no Electron imports (AGENTS.md rule 1); src/main/index.ts
// passes app.getPath('userData') and owns the startup failure gate.
//
// Storage contract (docs/02 §2.5, docs/03-agent-core.md §8): better-sqlite3,
// WAL mode, %APPDATA%/Agento/agento.db, repositories under src/main/storage/
// as the only code that touches the DB. Drizzle + migrations arrive with
// M1.3 — this module deliberately opens the file and nothing more.

let db: Database.Database | undefined

export function dbFilePath(userDataDir: string): string {
  return join(userDataDir, 'agento.db')
}

// Idempotent singleton: repeated calls return the same live handle. Storage
// repos (M1.3) call this instead of holding their own connection, and the
// module-level reference keeps better-sqlite3's GC finalizer from closing it.
export function openDatabase(userDataDir: string): Database.Database {
  if (db) return db

  // Electron usually creates the dir before ready; recursive mkdir makes the
  // module safe to call regardless of caller ordering.
  mkdirSync(userDataDir, { recursive: true })

  const database = new Database(dbFilePath(userDataDir))
  database.pragma('journal_mode = WAL')
  // NORMAL is the conventional WAL pairing: durable enough with WAL, and much
  // cheaper than FULL on every commit.
  database.pragma('synchronous = NORMAL')

  db = database
  return db
}

// One-query smoke test (docs/08 §7 M0 DB gate): returns true on success,
// throws on anything else — the caller decides how to surface the failure.
// The select proves the read path; the empty IMMEDIATE transaction after it
// proves the WAL write path and makes SQLite materialize the -wal/-shm files
// (a bare select never writes, so those files would not appear on first run).
// No schema is created or touched — tables arrive with M1.3.
export function runSmokeQuery(database: Database.Database): boolean {
  const row = database.prepare('select 1 as ok').get() as { ok: number } | undefined
  if (row?.ok !== 1) {
    throw new Error(
      `select-1 smoke query returned ${JSON.stringify(row) ?? 'undefined'}, expected { ok: 1 }`
    )
  }
  database.exec('BEGIN IMMEDIATE; COMMIT')
  return true
}
