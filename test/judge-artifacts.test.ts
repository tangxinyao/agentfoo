import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JudgeRecord, Trace } from '../src/types.js'

// The judge is a network call; replace it with one that records what it was asked
// to grade, so these stay offline like the rest of the unit suite.
const graded: string[] = []
/** Per-call overrides: each grading pops one `[score, missedMet]` pair, else the default below. */
const queue: Array<[number, boolean]> = []
vi.mock('../src/judge.js', () => ({
  defaultThreshold: () => 1,
  judge: async (text: string, _rubric: unknown, _cfg: unknown, threshold: number) => {
    graded.push(text)
    const next = queue.shift()
    if (next) {
      const [score, missedMet] = next
      return {
        passed: score >= threshold,
        score,
        threshold,
        breakdown: [
          { criteria: 'met one', weight: 3, met: true, reason: 'ok' },
          { criteria: 'missed one', weight: 1, met: missedMet, reason: missedMet ? 'there' : 'absent' },
        ],
      }
    }
    return {
      passed: true,
      score: 0.75,
      threshold,
      breakdown: [
        { criteria: 'met one', weight: 3, met: true, reason: 'ok' },
        { criteria: 'missed one', weight: 1, met: false, reason: 'absent' },
      ],
    }
  },
}))

// Registers the matchers against the mocked judge.
await import('agentfoo')
const { sanitize, testArtifactDir, readJudgeArtifacts, runDir } = await import('../src/artifacts.js')
const { buildTestReports, groupTests } = await import('../src/reporter.js')

function fakeTrace(): Trace {
  return {
    messages: [],
    toolCalls: [],
    raw: [],
    finalMessage: 'THE ANSWER',
    text: () => '[tool]\n<tool_result>SKILL.md: always explain the analogy limits</tool_result>\n\nTHE ANSWER',
  }
}

describe('toSatisfy target', () => {
  beforeEach(() => {
    graded.length = 0
    process.env.AGENTFOO_RUN_ID = `unit-${randomUUID().slice(0, 8)}`
  })
  afterEach(() => {
    rmSync(runDir(), { recursive: true, force: true })
    delete process.env.AGENTFOO_RUN_ID
  })

  it('grades a Trace by its finalMessage by default', async () => {
    await expect(fakeTrace()).toSatisfy('anything', { threshold: 0.5 })
    expect(graded).toEqual(['THE ANSWER'])
  })

  it("grades the whole transcript only with target: 'transcript'", async () => {
    await expect(fakeTrace()).toSatisfy('anything', { threshold: 0.5, target: 'transcript' })
    expect(graded[0]).toContain('SKILL.md')
  })

  it('grades a plain string as-is', async () => {
    await expect('just text').toSatisfy('anything', { threshold: 0.5 })
    expect(graded).toEqual(['just text'])
  })

  it('persists every grading, numbered per test, on pass as well as fail', async () => {
    await expect(fakeTrace()).toSatisfy('first', { threshold: 0.5 })
    await expect('second').toSatisfy('second', { threshold: 0.5 })

    const name = expect.getState().currentTestName!
    const dir = testArtifactDir(name)
    expect(existsSync(join(dir, 'judge-1.json'))).toBe(true)
    const second = JSON.parse(readFileSync(join(dir, 'judge-2.json'), 'utf8')) as JudgeRecord
    expect(second).toMatchObject({ test: name, index: 2, target: 'string', score: 0.75, passed: true })
    expect(second.breakdown).toHaveLength(2)

    expect(readJudgeArtifacts().map((r) => r.index)).toEqual([1, 2])
  })
})

describe('toSatisfy samples', () => {
  beforeEach(() => {
    graded.length = 0
    queue.length = 0
    process.env.AGENTFOO_RUN_ID = `unit-${randomUUID().slice(0, 8)}`
  })
  afterEach(() => {
    rmSync(runDir(), { recursive: true, force: true })
    delete process.env.AGENTFOO_RUN_ID
  })

  it('grades n times and records the mean, every score and the spread', async () => {
    queue.push([1, true], [0.75, false], [0.75, false])
    await expect('text').toSatisfy('r', { threshold: 0.8, samples: 3 })

    expect(graded).toHaveLength(3)
    const [record] = readJudgeArtifacts()
    expect(record.samples).toBe(3)
    expect(record.scores).toEqual([1, 0.75, 0.75])
    expect(record.score).toBeCloseTo(2.5 / 3)
    expect(record.stdev).toBeCloseTo(Math.sqrt(((1 / 6) ** 2 + 2 * (1 / 12) ** 2) / 3))
    expect(record.passed).toBe(true)
    // Majority verdict per criterion, with the fraction kept.
    expect(record.breakdown[1]).toMatchObject({ met: false, metRate: 1 / 3, reason: 'absent' })
  })

  it('fails on the mean even when one sample alone would have passed', async () => {
    queue.push([1, true], [0.5, false], [0.5, false])
    await expect(expect('text').toSatisfy('r', { threshold: 0.8, samples: 3 })).rejects.toThrow(
      /rubric score 0\.67 < threshold 0\.80[\s\S]*met 1\/3/,
    )
  })
})

describe('artifact paths', () => {
  it('keeps CJK letters so differently named tests get different directories', () => {
    expect(sanitize('写完整科普文章时触发')).toBe('写完整科普文章时触发')
    expect(testArtifactDir('解释单个概念')).not.toBe(testArtifactDir('无关的编程请求不触发'))
  })

  it('still replaces path separators and punctuation', () => {
    expect(sanitize('a/b\\c:d')).toBe('a_b_c_d')
    expect(sanitize('   ')).toBe('unnamed')
  })
})

describe('report.json test entries', () => {
  const cwd = '/repo'
  const files = [
    {
      filepath: '/repo/skills/x/x.spec.ts',
      tasks: [
        { name: 'top-level', result: { state: 'pass', duration: 10 }, meta: { split: 'train', n: 3 } },
        {
          name: 'group',
          tasks: [{ name: 'nested', result: { state: 'fail', duration: 20 }, meta: { split: 'train' } }],
        },
        { name: 'skipped', mode: 'skip' },
      ],
    },
  ]
  const judge = (test: string, index: number, met: boolean): JudgeRecord => ({
    test,
    index,
    model: 'deepseek/x',
    target: 'final',
    threshold: 1,
    score: met ? 1 : 0.5,
    passed: met,
    breakdown: [
      { criteria: 'a', weight: 1, met: true, reason: '' },
      { criteria: 'b', weight: 1, met, reason: '' },
    ],
    samples: 1,
    scores: [met ? 1 : 0.5],
    stdev: 0,
    gradedAt: '',
  })

  it('names tests the way vitest names currentTestName, so judge records attach', () => {
    const tests = buildTestReports(files, [judge('group > nested', 1, false)], cwd)
    expect(tests.map((t) => [t.file, t.name, t.state])).toEqual([
      ['skills/x/x.spec.ts', 'top-level', 'pass'],
      ['skills/x/x.spec.ts', 'group > nested', 'fail'],
      ['skills/x/x.spec.ts', 'skipped', 'skip'],
    ])
    expect(tests[1].judges).toEqual([
      {
        index: 1,
        model: 'deepseek/x',
        target: 'final',
        threshold: 1,
        score: 0.5,
        samples: 1,
        stdev: 0,
        passed: false,
        unmet: ['b'],
      },
    ])
    expect(tests[0].judges).toEqual([])
  })

  it('keeps only string meta, and groups tests by it with per-grading mean scores', () => {
    const tests = buildTestReports(
      files,
      [judge('top-level', 1, true), judge('group > nested', 1, false), judge('group > nested', 2, false)],
      cwd,
    )
    expect(tests[0].meta).toEqual({ split: 'train' })
    expect(tests[2].meta).toEqual({})

    expect(groupTests(tests)).toEqual({
      split: { train: { total: 2, passed: 1, failed: 1, skipped: 0, judgeMeans: [0.75, 0.5] } },
    })
  })
})
