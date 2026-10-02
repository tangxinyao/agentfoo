import { rmSync } from 'node:fs'
import { afterAll, describe, expect as globalExpect, test, vi } from 'vitest'

// A judge whose latency depends on the text, so the two tests' gradings overlap
// and finish in the opposite order from how they started.
vi.mock('../src/judge.js', () => ({
  defaultThreshold: () => 1,
  judge: async (text: string, _r: unknown, _c: unknown, threshold: number) => {
    await new Promise((r) => setTimeout(r, text === 'slow' ? 120 : 10))
    return { passed: true, score: 1, threshold, breakdown: [{ criteria: text, weight: 1, met: true, reason: 'ok' }] }
  },
}))

process.env.AGENTFOO_RUN_ID = `unit-conc-${Date.now()}`
await import('agentfoo')
const { readJudgeArtifacts, readTriggerArtifacts, runDir } = await import('../src/artifacts.js')
const { SkillHandle, skillFileReadDetector } = await import('../src/skill.js')

const fired = () => {
  const traces: unknown[] = []
  const handle = new SkillHandle('demo', '/s/demo', () => traces as never, skillFileReadDetector)
  traces.push({ messages: [], toolCalls: [{ name: 'read', arguments: { path: '/s/demo/SKILL.md' }, rawArguments: '{"path":"/s/demo/SKILL.md"}' }], raw: [], finalMessage: '', text: () => '' })
  return handle
}

describe('matcher records under test.concurrent', () => {
  test.concurrent('A starts first, finishes last', async ({ expect }) => {
    expect(fired()).toHaveBeenCalled()
    await expect('slow').toSatisfy('x')
  })
  test.concurrent('B starts second, finishes first', async ({ expect }) => {
    await new Promise((r) => setTimeout(r, 5))
    expect(fired()).toHaveBeenCalled()
    await expect('fast').toSatisfy('x')
  })

  afterAll(() => {
    const judges = readJudgeArtifacts().map((j) => [j.test, j.breakdown[0].criteria])
    const triggers = readTriggerArtifacts().map((t) => t.test)
    rmSync(runDir(), { recursive: true, force: true })
    delete process.env.AGENTFOO_RUN_ID
    globalExpect(judges).toEqual([
      ['matcher records under test.concurrent > A starts first, finishes last', 'slow'],
      ['matcher records under test.concurrent > B starts second, finishes first', 'fast'],
    ])
    globalExpect(triggers).toEqual([
      'matcher records under test.concurrent > A starts first, finishes last',
      'matcher records under test.concurrent > B starts second, finishes first',
    ])
  })
})
