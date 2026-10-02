import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agreement,
  loadReview,
  loadReviewCases,
  serveReview,
  validateReview,
  type RunReview,
} from '../src/review.js'
import { REVIEW_PAGE } from '../src/review-page.js'
import { effectiveState, loadEvidence } from '../src/suggest.js'
import type { JudgeRecord } from '../src/types.js'

let runPath: string

const judge = (test: string, met: boolean[]): JudgeRecord => ({
  test,
  index: 1,
  model: 'deepseek/x',
  target: 'string',
  threshold: 1,
  score: met.filter(Boolean).length / met.length,
  passed: met.every(Boolean),
  breakdown: met.map((m, i) => ({ criteria: `c${i + 1}`, weight: 1, met: m, reason: `r${i + 1}` })),
  samples: 1,
  scores: [0],
  stdev: 0,
  gradedAt: '',
})

function writeCase(name: string, met: boolean[]) {
  const dir = join(runPath, name.replace(/[^\p{L}\p{N}_.\- ]+/gu, '_').trim())
  mkdirSync(join(dir, 'turn-2'), { recursive: true })
  writeFileSync(
    join(dir, 'turn-2', 'trace.json'),
    JSON.stringify({ finalMessage: `answer to ${name}`, messages: [{ role: 'user', content: `prompt for ${name}` }] }),
  )
  writeFileSync(join(dir, 'judge-1.json'), JSON.stringify(judge(name, met)))
}

beforeEach(() => {
  runPath = mkdtempSync(join(tmpdir(), 'agentfoo-review-'))
  writeCase('[test/article] burn', [true, false])
  writeCase('[train/article] sky', [true, true])
  writeFileSync(
    join(runPath, 'report.json'),
    JSON.stringify({
      tests: [
        { name: '[test/article] burn', state: 'fail', meta: { split: 'test' } },
        { name: '[train/article] sky', state: 'pass', meta: { split: 'train' } },
      ],
    }),
  )
})
afterEach(() => rmSync(runPath, { recursive: true, force: true }))

describe('review data', () => {
  it('loads prompt, answer and full gradings per case', () => {
    const [burn] = loadReviewCases(runPath)
    expect(burn).toMatchObject({ state: 'fail', prompt: 'prompt for [test/article] burn', finalMessage: 'answer to [test/article] burn' })
    expect(burn.judges[0].breakdown.map((b) => b.reason)).toEqual(['r1', 'r2'])
  })

  it('starts empty and rejects malformed reviews', () => {
    expect(loadReview(runPath).cases).toEqual({})
    expect(() => validateReview({ cases: { a: { rating: 7 } } })).toThrow(/1–5/)
    expect(() => validateReview({ cases: { a: { verdicts: { '1:1': 'maybe' } } } })).toThrow(/agree/)
    expect(() => validateReview({})).toThrow(/cases/)
  })

  it('computes human–judge agreement', () => {
    const r: RunReview = { run: 'x', cases: { a: { verdicts: { '1:1': 'agree', '1:2': 'disagree' } }, b: { verdicts: { '1:1': 'agree' } } } }
    expect(agreement(r)).toEqual({ agree: 2, disagree: 1, rate: 2 / 3 })
  })
})

describe('review server', () => {
  it('serves the page and the run, and persists a valid review only', async () => {
    const { server, url } = await serveReview(runPath, 0)
    try {
      expect(await (await fetch(url)).text()).toContain('agentfoo review')
      const run = (await (await fetch(`${url}api/run`)).json()) as { cases: unknown[] }
      expect(run.cases).toHaveLength(2)

      const good = { cases: { '[test/article] burn': { rating: 2, verdicts: { '1:2': 'disagree' } } } }
      const ok = await fetch(`${url}api/review`, { method: 'PUT', body: JSON.stringify(good) })
      expect(await ok.json()).toMatchObject({ ok: true, agreement: { disagree: 1 } })
      expect(JSON.parse(readFileSync(join(runPath, 'review.json'), 'utf8')).cases).toEqual(good.cases)

      const bad = await fetch(`${url}api/review`, { method: 'PUT', body: '{"cases":{"x":{"rating":9}}}' })
      expect(bad.status).toBe(400)
      expect(JSON.parse(readFileSync(join(runPath, 'review.json'), 'utf8')).cases).toEqual(good.cases)
    } finally {
      server.close()
    }
  })

  it('ships a page whose script at least parses', () => {
    const script = REVIEW_PAGE.match(/<script>([\s\S]*)<\/script>/)![1]
    expect(() => new Function(script)).not.toThrow()
  })
})

describe('suggest with a human review', () => {
  it('drops overruled verdicts from the evidence and lets the rating decide pass/fail', () => {
    writeFileSync(
      join(runPath, 'review.json'),
      JSON.stringify({
        run: 'x',
        cases: {
          '[test/article] burn': { rating: 4, verdicts: { '1:2': 'disagree' }, comment: 'judge was too literal' },
          '[train/article] sky': { rating: 1, comment: 'factually fine but unreadable' },
        },
      }),
    )
    const [burn, sky] = loadEvidence(runPath)
    expect(burn.judges[0].unmet).toEqual([])
    expect(burn.judges[0].overruled).toEqual([{ criteria: 'c2', judgeSaid: 'unmet' }])
    expect(effectiveState(burn)).toBe('pass')
    expect(sky.human).toMatchObject({ rating: 1, comment: 'factually fine but unreadable' })
    expect(effectiveState(sky)).toBe('fail')
  })
})
