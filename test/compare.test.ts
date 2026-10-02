import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Replay pairwise verdicts in call order; record the prompts.
const asked: string[] = []
const replies: Array<{ winner: string; reason: string }> = []
vi.mock('../src/judge.js', () => ({
  completeJson: async (_c: unknown, _s: string, user: string) => {
    asked.push(user)
    return replies.shift() ?? { winner: 'tie', reason: '' }
  },
}))

const { compareRuns, judgePair, summarize } = await import('../src/compare.js')
const { humanSummary, serveCompare } = await import('../src/review.js')
const { COMPARE_PAGE } = await import('../src/compare-page.js')

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentfoo-cmp-'))
  asked.length = 0
  replies.length = 0
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function run(id: string, answers: Record<string, string>): string {
  const dir = join(root, id)
  for (const [name, answer] of Object.entries(answers)) {
    const d = join(dir, name.replace(/[^\p{L}\p{N}_.\- ]+/gu, '_').trim(), 'turn-1')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'trace.json'), JSON.stringify({ finalMessage: answer, messages: [{ role: 'user', content: `prompt ${name}` }] }))
  }
  writeFileSync(
    join(dir, 'report.json'),
    JSON.stringify({ tests: Object.keys(answers).map((name) => ({ name, state: 'pass', meta: { split: 'sel' }, judges: [{ score: 1 }] })) }),
  )
  return dir
}

describe('judgePair', () => {
  it('asks both orders and only lets a side win if it wins both', async () => {
    replies.push({ winner: '2', reason: 'B clearer' }, { winner: '1', reason: 'B clearer' }) // B wins as 2nd, then as 1st
    const v = await judgePair({ model: 'x/y' }, 'q', 'answer A', 'answer B')
    expect(v).toMatchObject({ winner: 'b', orders: ['b', 'b'] })
    expect(asked[0].indexOf('answer A')).toBeLessThan(asked[0].indexOf('answer B'))
    expect(asked[1].indexOf('answer B')).toBeLessThan(asked[1].indexOf('answer A'))
  })

  it('turns an order-dependent verdict (position bias) into a tie', async () => {
    replies.push({ winner: '1', reason: '' }, { winner: '1', reason: '' }) // always prefers whatever is first
    expect((await judgePair({ model: 'x/y' }, 'q', 'a', 'b')).winner).toBe('tie')
  })
})

describe('summarize', () => {
  it('counts ties as half and gives a Wilson interval', () => {
    const s = summarize(['b', 'b', 'b', 'a', 'tie'])
    expect(s).toMatchObject({ a: 1, b: 3, tie: 1 })
    expect(s.bWinRate).toBeCloseTo(3.5 / 5)
    expect(s.ci![0]).toBeLessThan(0.7)
    expect(s.ci![1]).toBeGreaterThan(0.7)
    expect(summarize([]).ci).toBeNull()
  })
})

describe('compareRuns + human preferences', () => {
  it('pairs cases present in both runs and summarizes judge and human verdicts', async () => {
    const aRun = run('A', { c1: 'old one', c2: 'old two', onlyA: 'x' })
    const bRun = run('B', { c1: 'new one', c2: 'new two' })
    replies.push({ winner: '2', reason: '' }, { winner: '1', reason: '' }, { winner: '1', reason: '' }, { winner: '2', reason: '' })
    const r = await compareRuns({ aDir: 'a', bDir: 'b', aRun, bRun, judge: { model: 'x/y' } })
    expect(r.cases.map((c) => [c.name, c.judge!.winner])).toEqual([['c1', 'b'], ['c2', 'a']])
    expect(r.summary).toMatchObject({ a: 1, b: 1, tie: 0 })

    const h = humanSummary(r, { cases: { c1: { pick: 'b' }, c2: { pick: 'b' } } })
    expect(h).toMatchObject({ b: 2, judgeAgreement: 0.5 })
  })

  it('serves the blind page and persists only valid preferences', async () => {
    const dir = join(root, 'cmp')
    mkdirSync(dir)
    writeFileSync(join(dir, 'compare.json'), JSON.stringify({ cases: [{ name: 'c1', meta: {}, prompt: 'p', a: 'x', b: 'y' }] }))
    const { server, url } = await serveCompare(dir, 0)
    try {
      expect(await (await fetch(url)).text()).toContain('agentfoo compare')
      const ok = await fetch(`${url}api/preferences`, { method: 'PUT', body: JSON.stringify({ cases: { c1: { pick: 'b' } } }) })
      expect((await ok.json()).ok).toBe(true)
      expect(JSON.parse(readFileSync(join(dir, 'preferences.json'), 'utf8')).cases.c1.pick).toBe('b')
      const bad = await fetch(`${url}api/preferences`, { method: 'PUT', body: '{"cases":{"c1":{"pick":"left"}}}' })
      expect(bad.status).toBe(400)
    } finally {
      server.close()
    }
  })

  it('ships a compare page whose script parses', () => {
    const script = COMPARE_PAGE.match(/<script>([\s\S]*)<\/script>/)![1]
    expect(() => new Function(script)).not.toThrow()
  })
})
