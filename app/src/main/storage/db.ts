import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import * as schema from './schema'

// Plain Node only — no Electron imports (AGENTS.md rule 1); src/main/index.ts
// passes app.getPath('userData'), the migrations folder path, and owns the
// startup failure gate.
//
// Storage contract (docs/02 §2.5, docs/03-agent-core.md §8): better-sqlite3,
// WAL mode, %APPDATA%/Agento/agento.db, drizzle-kit migrations run at startup,
// repositories under src/main/storage/ as the only code that touches the DB.

let db: Database.Database | undefined
let driz: BetterSQLite3Database<typeof schema> | undefined

export function dbFilePath(userDataDir: string): string {
  return join(userDataDir, 'agento.db')
}

// Idempotent singleton: repeated calls return the same live handle. Storage
// repos call getDatabase()/getDrizzle() instead of holding their own
// connection, and the module-level reference keeps better-sqlite3's GC
// finalizer from closing it.
//
// migrationsFolder is passed in from index.ts (dev: <app>/drizzle next to the
// sources; the packaged-app path is an M6.6 question). The migrator records
// applied files in its own __drizzle_migrations table, so an existing
// pre-M1.3 database (empty agento.db from M0.6) migrates up cleanly.
export async function openDatabase(
  userDataDir: string,
  migrationsFolder: string
): Promise<Database.Database> {
  if (db) return db

  // Electron usually creates the dir before ready; recursive mkdir makes the
  // module safe to call regardless of caller ordering.
  mkdirSync(userDataDir, { recursive: true })

  const database = new Database(dbFilePath(userDataDir))
  database.pragma('journal_mode = WAL')
  // NORMAL is the conventional WAL pairing: durable enough with WAL, and much
  // cheaper than FULL on every commit.
  database.pragma('synchronous = NORMAL')
  // FKs are off by default in SQLite and per-connection: the messages ->
  // sessions reference in docs/03 §8 only exists if this is set on every open.
  database.pragma('foreign_keys = ON')

  driz = drizzle(database, { schema })
  await migrate(driz, { migrationsFolder })

  db = database
  return db
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Storage not opened yet — call openDatabase() first.')
  return db
}

export function getDrizzle(): BetterSQLite3Database<typeof schema> {
  if (!driz) throw new Error('Storage not opened yet — call openDatabase() first.')
  return driz
}

// One-query smoke test (docs/08 §7 M0 DB gate): returns true on success,
// throws on anything else — the caller decides how to surface the failure.
// The select proves the read path; the empty IMMEDIATE transaction after it
// proves the WAL write path and makes SQLite materialize the -wal/-shm files
// (a bare select never writes, so those files would not appear on first run).
// Runs after the migrations, so it also proves the migrated schema loads.
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
