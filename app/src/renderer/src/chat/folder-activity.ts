// Folder activity stats (Workspace Overview): pure derivation from the
// session list for one workspace folder. No node:, no window — the component
// (DOM surface, manual checklist) stays out of vitest; this contract is the
// behavior proof. The input is a minimal structural interface (NOT the
// renderer's SessionSummary) so this module never pulls transport.ts → the
// `ai` package into the node-env test scope — same doctrine as
// suggestions.ts's ScannedFile.

export interface FolderSession {
  workspacePath: string
  usage: { inputTokens: number; outputTokens: number } | null
  updatedAt: string
}

export interface FolderActivity {
  /** Sessions bound to this folder. */
  chatCount: number
  /** Sum of input + output tokens across bound sessions that have runs. */
  totalTokens: number
}

export function summarizeFolderSessions(
  sessions: FolderSession[],
  workspacePath: string
): FolderActivity {
  const current = workspacePath.toLowerCase()
  const activity: FolderActivity = { chatCount: 0, totalTokens: 0 }
  if (!current) return activity
  for (const session of sessions) {
    if (session.workspacePath.toLowerCase() !== current) continue
    activity.chatCount += 1
    if (session.usage) {
      activity.totalTokens += session.usage.inputTokens + session.usage.outputTokens
    }
  }
  return activity
}

// Compact token display for the activity boxes: exact below 1k, `~Nk` above.
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  return `~${Math.round(tokens / 1000)}k`
}

// Newest activity in the folder as an ISO timestamp, or null when there is
// nothing (or nothing parseable) to show. Powers the "Last active" box —
// the folder-level recency neither the sidebar nor the counts provide.
export function lastActiveAt(sessions: FolderSession[], workspacePath: string): string | null {
  const current = workspacePath.toLowerCase()
  if (!current) return null
  let latest: string | null = null
  let latestTime = Number.NaN
  for (const session of sessions) {
    if (session.workspacePath.toLowerCase() !== current) continue
    const time = new Date(session.updatedAt).getTime()
    if (Number.isNaN(time)) continue
    if (latest === null || time > latestTime) {
      latest = session.updatedAt
      latestTime = time
    }
  }
  return latest
}
