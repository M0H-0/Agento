import { describe, expect, it } from 'vitest'
import { verifyStep } from './verify'

// M3.5 client: fake-fetch proofs (the real endpoint lands in M4.3).
describe('verifyStep (M3.5)', () => {
  const input = {
    instructionSegment: 'organize',
    stepDescription: 'move files',
    actions: [],
    beforeAfter: { before: null, after: null }
  }

  it('sidecar unhealthy → skipped without calling fetch', async () => {
    let called = 0
    const verdict = await verifyStep(
      {
        sidecarHealth: () => 'unhealthy',
        fetchVerify: async () => {
          called += 1
          return { status: 200, json: async () => ({}) }
        }
      },
      input
    )
    expect(verdict).toEqual({ verdict: 'skipped' })
    expect(called).toBe(0)
  })

  it('score 0.9 + complete → complete', async () => {
    const verdict = await verifyStep(
      {
        sidecarHealth: () => 'healthy',
        fetchVerify: async () => ({
          status: 200,
          json: async () => ({
            completion_score: 0.9,
            is_complete: true,
            missed_segments: []
          })
        })
      },
      input
    )
    expect(verdict).toEqual({ verdict: 'complete', score: 0.9 })
  })

  it('score 0.5 + missed segments → incomplete with segments', async () => {
    const verdict = await verifyStep(
      {
        sidecarHealth: () => 'healthy',
        fetchVerify: async () => ({
          status: 200,
          json: async () => ({
            completion_score: 0.5,
            is_complete: false,
            missed_segments: ['the summary is missing']
          })
        })
      },
      input
    )
    expect(verdict).toEqual({
      verdict: 'incomplete',
      score: 0.5,
      missedSegments: ['the summary is missing']
    })
  })

  it('fetch throws → skipped (badges never faked)', async () => {
    const verdict = await verifyStep(
      {
        sidecarHealth: () => 'healthy',
        fetchVerify: async () => {
          throw new Error('down')
        }
      },
      input
    )
    expect(verdict).toEqual({ verdict: 'skipped' })
  })
})
