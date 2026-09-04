import { defineConfig } from 'drizzle-kit'

// Migration generation only (`npx drizzle-kit generate`): the committed SQL in
// ./drizzle is applied at app startup by drizzle's better-sqlite3 migrator
// (src/main/storage/db.ts, folder path passed in from src/main/index.ts).
// Schema of record: docs/03-agent-core.md §8.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/storage/schema.ts',
  out: './drizzle'
})
