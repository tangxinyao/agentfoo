import { describe, expect as globalExpect, it, vi } from 'vitest'

vi.mock('../src/judge.js', () => ({
  defaultThreshold: () => 1,
  judge: async (_t: string, _r: unknown, _c: unknown, threshold: number) => ({
    passed: true, score: 1, threshold, breakdown: [{ criteria: 'c', weight: 1, met: true, reason: 'ok' }],
  }),
}))
await import('agentfoo')

describe('matchers on the test-context expect (needed under test.concurrent)', () => {
  it('toSatisfy is the rubric matcher, not vitest’s predicate one', async ({ expect }) => {
    await expect('text').toSatisfy('some criterion', { threshold: 1 })
  })
  it('global expect still works', async () => {
    await globalExpect('text').toSatisfy('some criterion', { threshold: 1 })
  })
})

describe('vitest’s own predicate toSatisfy keeps working', () => {
  it('on the context expect', ({ expect }) => {
    expect(4).toSatisfy((n: number) => n % 2 === 0)
    expect(() => expect(3).toSatisfy((n: number) => n % 2 === 0)).toThrow()
  })
})
