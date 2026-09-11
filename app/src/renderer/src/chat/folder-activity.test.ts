import { describe, expect, it } from 'vitest'
import {
  type FolderSession,
  formatTokenCount,
  lastActiveAt,
  summarizeFolderSessions
} from './folder-activity'

const WS = 'D:\\Work\\notes'

function session(
  overrides: {
    workspacePath?: string
    usage?: { inputTokens: number; outputTokens: number } | null
    updatedAt?: string
  } = {}
): FolderSession {
  return {
    workspacePath: overrides.workspacePath ?? WS,
    usage: overrides.usage ?? null,
    updatedAt: overrides.updatedAt ?? '2026-09-10T10:00:00.000Z'
  }
}

describe('summarizeFolderSessions', () => {
  it('returns zeros for no sessions or no workspace', () => {
    expect(summarizeFolderSessions([], WS)).toEqual({ chatCount: 0, totalTokens: 0 })
    expect(summarizeFolderSessions([session()], '')).toEqual({
      chatCount: 0,
      totalTokens: 0
    })
  })

  it('ignores sessions bound to other folders, matching case-insensitively', () => {
    const sessions = [
      session({ usage: { inputTokens: 100, outputTokens: 50 } }),
      session({ workspacePath: 'd:\\work\\NOTES' }),
      session({ workspacePath: 'D:\\other' })
    ]
    expect(summarizeFolderSessions(sessions, WS)).toEqual({
      chatCount: 2,
      totalTokens: 150
    })
  })

  it('counts run-less sessions as chats but only sums settled run tokens', () => {
    const sessions = [
      session({ usage: { inputTokens: 900, outputTokens: 100 } }),
      session({ usage: { inputTokens: 2500, outputTokens: 500 } }),
      session()
    ]
    expect(summarizeFolderSessions(sessions, WS)).toEqual({
      chatCount: 3,
      totalTokens: 4000
    })
  })
})

describe('formatTokenCount', () => {
  it('is exact below 1k and compact above', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1000)).toBe('~1k')
    expect(formatTokenCount(12400)).toBe('~12k')
  })
})

describe('lastActiveAt', () => {
  it('returns null with no sessions, no workspace, or nothing parseable', () => {
    expect(lastActiveAt([], WS)).toBeNull()
    expect(lastActiveAt([session()], '')).toBeNull()
    expect(lastActiveAt([session({ workspacePath: 'D:\\other' })], WS)).toBeNull()
    expect(lastActiveAt([session({ updatedAt: 'not-a-date' })], WS)).toBeNull()
  })

  it('picks the newest bound session, matching the folder case-insensitively', () => {
    const sessions = [
      session({ updatedAt: '2026-09-08T10:00:00.000Z' }),
      session({ updatedAt: '2026-09-11T10:00:00.000Z' }),
      session({ workspacePath: 'd:\\WORK\\notes', updatedAt: '2026-09-09T10:00:00.000Z' }),
      session({ workspacePath: 'D:\\other', updatedAt: '2026-09-12T10:00:00.000Z' })
    ]
    expect(lastActiveAt(sessions, WS)).toBe('2026-09-11T10:00:00.000Z')
  })
})
