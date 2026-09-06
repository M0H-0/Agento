import { defineConfig } from 'vitest/config'

// First test runner in app/ (vitest 5.0.0 lands at M2.1 — STACK.md row
// already present, verified on disk). Node environment only: the agent tree is
// plain Node TS and must stay Electron-free (AGENTS.md rule 1); any future DOM
// test needs its own project/environment decision.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/main/**/*.test.ts']
  }
})
