import { describe, expect, it } from 'vitest'
import { createApprovalCoalescer, parseCountFromText } from './coalesce'
import type { ApprovalRequest } from './types'

describe('parseCountFromText (M3.3 projection)', () => {
  it('parses digit counts', () => {
    expect(parseCountFromText('Move 42 files into Archive')).toBe(42)
    expect(parseCountFromText('delete 3 items')).toBe(3)
  })

  it.each([
    ['انقل ملفات PDF (3) إلى PDFs', 3],
    ['انقل المستندات (٣٥) إلى Documents', 35],
    ['انقل ۱۲ ملفًا إلى Text', 12],
    ['انقل ٤٢ ملفات إلى Archive', 42],
    ['Move the 4 spreadsheets into Spreadsheets', 4],
    ['Move the 2 presentations into Presentations', 2],
    ['Move the 3 text files into Text', 3]
  ])('parses saved-plan count in %s', (text, count) => {
    expect(parseCountFromText(text as string)).toBe(count)
  })

  it('parses number words', () => {
    expect(parseCountFromText('Move all six .txt files into Archive')).toBe(6)
    expect(parseCountFromText('organize the twelve notes')).toBe(12)
  })

  it('returns null when no batch size is stated', () => {
    expect(parseCountFromText('Move every .txt file into Archive')).toBeNull()
    expect(parseCountFromText('Create a new folder')).toBeNull()
  })
})

// M3.3 stub: 42 same-shape calls ask once with the count shown.
describe('approval coalescing stub (M3.3)', () => {
  it('42 same-tool calls emit one request; approve runs all', async () => {
    const order: string[] = []
    let requests = 0
    const coalescer = createApprovalCoalescer(async (): Promise<'approve'> => {
      requests += 1
      order.push('approval')
      return 'approve'
    })
    const req = (i: number): ApprovalRequest => ({
      tool: 'move_path',
      title: `Move ${i}`,
      riskLevel: 2 as const,
      reason: 'move',
      paths: [`C:/ws/${i}.txt`]
    })
    const pendings = Array.from({ length: 42 }, (_, i) => {
      order.push('request')
      return coalescer.request(req(i))
    })
    const decisions = await Promise.all(pendings)
    expect(requests).toBe(1)
    expect(decisions.every((d) => d === 'approve')).toBe(true)
    expect(coalescer.groupCount('move_path')).toBe(42)
    // First call opened the group before the decision resolved.
    expect(order[0]).toBe('request')
    expect(order).toContain('approval')
  })

  it('skip fans out to every buffered call', async () => {
    const coalescer = createApprovalCoalescer(async (): Promise<'skip'> => 'skip')
    const req = (): ApprovalRequest => ({
      tool: 'move_path',
      title: 'Move',
      riskLevel: 2 as const,
      reason: 'move',
      paths: ['C:/ws/a.txt']
    })
    const results = await Promise.all([coalescer.request(req()), coalescer.request(req())])
    expect(results).toEqual(['skip', 'skip'])
  })

  it('buffered calls re-emit the running count via onBuffered', async () => {
    const seen: { tool: string; count: number }[] = []
    const coalescer = createApprovalCoalescer(
      async (): Promise<'approve'> => {
        // Hold the group open until both calls have buffered.
        await new Promise((r) => setTimeout(r, 50))
        return 'approve'
      },
      {
        onBuffered: (tool: string, displayCount: number | null): void =>
          void seen.push({ tool, count: displayCount ?? 0 })
      }
    )
    const req = (): ApprovalRequest => ({
      tool: 'move_path',
      title: 'Move',
      riskLevel: 2 as const,
      reason: 'move',
      paths: ['C:/ws/a.txt']
    })
    const results = await Promise.all([coalescer.request(req()), coalescer.request(req())])
    expect(results).toEqual(['approve', 'approve'])
    expect(seen).toEqual([{ tool: 'move_path', count: 2 }])
  })

  it('25% over-projection pauses and re-asks once with the real count', async () => {
    const seenCounts: (number | null)[] = []
    const coalescer = createApprovalCoalescer(async (_req, displayCount): Promise<'approve'> => {
      seenCounts.push(displayCount)
      return 'approve'
    })
    const req = (): ApprovalRequest => ({
      tool: 'move_path',
      title: 'Move',
      riskLevel: 2 as const,
      reason: 'move',
      paths: ['C:/ws/a.txt']
    })
    // Projection 4: calls 1–5 run under one decision (5 <= floor(4*1.25)).
    const first = await Promise.all(Array.from({ length: 5 }, () => coalescer.request(req(), 4)))
    expect(first.every((d) => d === 'approve')).toBe(true)
    expect(seenCounts).toEqual([4])
    // 6th call exceeds 4*1.25 → exactly one re-ask with the real count.
    expect(await coalescer.request(req(), 4)).toBe('approve')
    expect(seenCounts).toEqual([4, 6])
    // 7th call runs under the re-ask decision with no third modal.
    expect(await coalescer.request(req(), 4)).toBe('approve')
    expect(seenCounts).toEqual([4, 6])
  })

  it('post-decision calls run immediately under the recorded decision', async () => {
    const coalescer = createApprovalCoalescer(async (): Promise<'approve'> => 'approve')
    const req = (): ApprovalRequest => ({
      tool: 'copy_path',
      title: 'Copy',
      riskLevel: 2 as const,
      reason: 'copy',
      paths: ['C:/ws/a.txt']
    })
    expect(await coalescer.request(req())).toBe('approve')
    expect(await coalescer.request(req())).toBe('approve')
  })

  it('post-decision arrivals never re-emit the dialog count', async () => {
    const seen: number[] = []
    const coalescer = createApprovalCoalescer(async (): Promise<'approve'> => 'approve', {
      onBuffered: (_tool: string, displayCount: number | null): void =>
        void seen.push(displayCount ?? 0)
    })
    const req = (): ApprovalRequest => ({
      tool: 'delete_path',
      title: 'Delete',
      riskLevel: 3 as const,
      reason: 'delete',
      paths: ['C:/ws/a.txt']
    })
    // First call opens and resolves the group (no buffering, no re-emit).
    expect(await coalescer.request(req())).toBe('approve')
    expect(seen).toEqual([])
    // A late duplicate (same run, next step) resolves silently — re-emitting
    // here reopened an already-approved modal in the renderer.
    expect(await coalescer.request(req())).toBe('approve')
    expect(seen).toEqual([])
  })
})
