import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aggregateRuns, formatScore } from '../src/score.js'

let root: string
beforeEach(() => (root = mkdtempSync(join(tmpdir(), 'agentfoo-score-'))))
afterEach(() => rmSync(root, { recursive: true, force: true }))

function run(id: string, tests: Array<[string, string, number[], Record<string, string>?]>): string {
  const dir = join(root, id)
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'report.json'),
    JSON.stringify({
      tests: tests.map(([name, state, scores, meta]) => ({ name, state, meta: meta ?? {}, judges: scores.map((score) => ({ score })) })),
    }),
  )
  return dir
}

describe('aggregateRuns', () => {
  it('gives each case its pass count, mean and spread across runs, and groups by meta', () => {
    const r = aggregateRuns([
      run('a', [['steady', 'pass', [1], { split: 'train' }], ['flaky', 'pass', [1, 1], { split: 'sel' }], ['neg', 'pass', [], { split: 'sel' }]]),
      run('b', [['steady', 'pass', [1], { split: 'train' }], ['flaky', 'fail', [0.5, 0.5], { split: 'sel' }], ['neg', 'fail', [], { split: 'sel' }]]),
    ])
    const flaky = r.cases.find((c) => c.name === 'flaky')!
    expect(flaky).toMatchObject({ runs: 2, passes: 1, scores: [1, 0.5], mean: 0.75, stdev: 0.25 })
    expect(r.cases.find((c) => c.name === 'neg')).toMatchObject({ scores: [1, 0], passes: 1 })
    expect(r.groups.split.train).toEqual({ cases: 1, mean: 1, passRate: 1 })
    expect(r.groups.split.sel.passRate).toBe(0.5)
    expect(r.overall.passRate).toBeCloseTo(4 / 6)
    // suite score per run: a = 1, b = (1 + 0.5 + 0) / 3 → spread 0.25
    expect(r.overall.stdev).toBeCloseTo(0.25)
    expect(formatScore(r)).toMatch(/flakiest cases[\s\S]*0\.75 ± 0\.25\s+1\/2 passed\s+flaky/)
  })
})
