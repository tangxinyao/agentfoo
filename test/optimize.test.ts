import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// suggest() is the model-backed backward pass; replace it with one that appends
// a numbered rule, so each candidate is distinct and its content is predictable.
let proposals = 0
const metaSeen: Array<string | undefined> = []
vi.mock('../src/suggest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/suggest.js')>()),
  suggest: async (o: { skillDir: string; outDir: string; rejected: unknown[]; meta?: string }) => {
    metaSeen.push(o.meta)
    rejectedSeen.push(o.rejected.length)
    const n = ++proposals
    mkdirSync(o.outDir, { recursive: true })
    const skill = readFileSync(join(o.skillDir, 'SKILL.md'), 'utf8')
    writeFileSync(join(o.outDir, 'SKILL.suggested.md'), `${skill}\n- rule ${n}\n`)
    const edit = { op: 'append', content: `- rule ${n}`, rationale: `r${n}` }
    return { outDir: o.outDir, failures: 1, successes: 0, edits: [edit], results: [{ edit, applied: true }] }
  },
}))
const rejectedSeen: number[] = []

// Slow update / meta memory / pairwise all go through completeJson.
const modelCalls: string[] = []
vi.mock('../src/judge.js', () => ({
  completeJson: async (_c: unknown, system: string, user: string) => {
    modelCalls.push(system.slice(0, 40))
    if (system.includes('long-horizon guidance')) return { guidance: '- keep answers short' }
    if (system.includes('private notes')) return { notes: '- appending rules helped' }
    // Pairwise: prefer whichever response is the candidate's, in either position.
    const first = user.split('# Response 2')[0]
    return { winner: first.includes('candidate') ? '1' : '2', reason: 'candidate better' }
  },
}))

const { cosineBudget, optimize, runObjective } = await import('../src/optimize.js')

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentfoo-opt-'))
  proposals = 0
  rejectedSeen.length = 0
  metaSeen.length = 0
  modelCalls.length = 0
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function writeRun(id: string, tests: Array<{ state: string; judges: number[] }>): string {
  const dir = join(root, 'runs', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'report.json'),
    JSON.stringify({ tests: tests.map((t, i) => ({ name: `case-${i}`, state: t.state, judges: t.judges.map((score) => ({ score })) })) }),
  )
  return dir
}

describe('runObjective', () => {
  it('averages per-test mean judge scores; judgeless tests count by state; skips ignored', () => {
    const run = writeRun('r', [
      { state: 'fail', judges: [1, 0.5] },
      { state: 'pass', judges: [] },
      { state: 'fail', judges: [] },
      { state: 'skip', judges: [] },
    ])
    expect(runObjective(run)).toBeCloseTo((0.75 + 1 + 0) / 3)
  })
})

describe('cosineBudget', () => {
  it('decays from max to min', () => {
    expect([0, 1, 2, 3].map((s) => cosineBudget(s, 4, 4, 2))).toEqual([4, 4, 3, 2])
    expect(cosineBudget(0, 1, 4, 2)).toBe(4)
  })
})

describe('optimize', () => {
  it('accepts only candidates that beat the current selection score, and feeds rejections back', async () => {
    const skillDir = join(root, 'skill')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\n---\n\n# Demo\n')

    // Selection scores by candidate: baseline 0.5, rule 1 → 0.7 (accept), rule 2 → 0.6 (reject).
    const selScore = (overrides: Record<string, string>) => {
      const dir = overrides.demo
      if (!dir) return 0.5
      const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8')
      return skill.includes('rule 2') ? 0.6 : 0.7
    }
    const seen: Array<{ filter: string; overrides: Record<string, string> }> = []
    const runner = async (filter: string, overrides: Record<string, string>, runId: string) => {
      seen.push({ filter, overrides })
      return filter === 'SEL'
        ? writeRun(runId, [{ state: 'fail', judges: [selScore(overrides)] }])
        : writeRun(runId, [{ state: 'fail', judges: [0.4] }])
    }

    const result = await optimize({
      skillDir,
      trainFilter: 'TRAIN',
      selFilter: 'SEL',
      optimizer: { model: 'x/y' },
      outDir: join(root, 'out'),
      epochs: 1,
      stepsPerEpoch: 2,
      runner,
    })

    expect(result.baseline).toBe(0.5)
    expect(result.best).toBe(0.7)
    expect(result.steps.map((s) => s.accepted)).toEqual([true, false])
    // Step 2 trains from the accepted candidate, and step 3 would see its rejection.
    expect(seen[3].overrides.demo).toContain('step-1')
    expect(rejectedSeen).toEqual([0, 0])
    expect(readFileSync(join(result.bestDir, 'SKILL.md'), 'utf8')).toContain('rule 1')
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toBe('---\nname: demo\n---\n\n# Demo\n')
  })

  it("with margin 'auto', measures baseline noise and demands more than it", async () => {
    const skillDir = join(root, 'skill2')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo2\n---\n\n# Demo\n')
    const baselines = [0.4, 0.6] // mean 0.5, stdev 0.1
    const runner = async (filter: string, overrides: Record<string, string>, runId: string) =>
      filter === 'SEL' && !overrides.demo2
        ? writeRun(runId, [{ state: 'fail', judges: [baselines.shift()!] }])
        : writeRun(runId, [{ state: 'fail', judges: [filter === 'SEL' ? 0.55 : 0.4] }]) // +0.05 < noise

    const result = await optimize({
      skillDir, trainFilter: 'TRAIN', selFilter: 'SEL', optimizer: { model: 'x/y' },
      outDir: join(root, 'out2'), epochs: 1, stepsPerEpoch: 1, margin: 'auto', runner,
    })
    expect(result.baseline).toBeCloseTo(0.5)
    expect(result.margin).toBeCloseTo(0.1)
    expect(result.steps[0].accepted).toBe(false)
  })

  it('runs the epoch-wise slow update into a protected block and carries optimizer notes forward', async () => {
    const skillDir = join(root, 'skill3')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo3\n---\n\n# Demo\n')
    const runner = async (filter: string, overrides: Record<string, string>, runId: string) => {
      const skill = overrides.demo3 ? readFileSync(join(overrides.demo3, 'SKILL.md'), 'utf8') : ''
      // Every candidate improves the selection score a little; the slow block most.
      const sel = 0.5 + (skill.match(/rule/g)?.length ?? 0) * 0.05 + (skill.includes('SLOW_UPDATE_START') ? 0.2 : 0)
      return filter === 'SEL' ? writeRun(runId, [{ state: 'fail', judges: [sel] }]) : writeRun(runId, [{ state: 'fail', judges: [0.4] }])
    }
    const result = await optimize({
      skillDir, trainFilter: 'TRAIN', selFilter: 'SEL', optimizer: { model: 'x/y' },
      outDir: join(root, 'out3'), epochs: 2, stepsPerEpoch: 1, runner,
    })
    const slow = result.steps.find((s) => s.reason === 'slow update')!
    expect(slow.slowUpdate).toBe('- keep answers short')
    expect(slow.accepted).toBe(true)
    const best = readFileSync(join(result.bestDir, 'SKILL.md'), 'utf8')
    expect(best).toMatch(/<!-- SLOW_UPDATE_START -->[\s\S]*keep answers short[\s\S]*<!-- SLOW_UPDATE_END -->/)
    expect(result.meta).toBe('- appending rules helped')
    expect(readFileSync(join(root, 'out3', 'meta.md'), 'utf8')).toContain('appending rules helped')
    // Epoch 1 had no notes yet; the notes are written at the end of epoch 2.
    expect(metaSeen[0]).toBe('')
  })

  it('with gate pairwise, accepts on the candidate winning case by case', async () => {
    const skillDir = join(root, 'skill4')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo4\n---\n\n# Demo\n')
    const answerRun = (runId: string) => {
      const dir = writeRun(runId, [{ state: 'pass', judges: [1] }])
      mkdirSync(join(dir, 'case', 'turn-1'), { recursive: true })
      writeFileSync(join(dir, 'case', 'turn-1', 'trace.json'), JSON.stringify({ finalMessage: runId, messages: [{ role: 'user', content: 'q' }] }))
      const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
      report.tests[0].name = 'case'
      writeFileSync(join(dir, 'report.json'), JSON.stringify(report))
      return dir
    }
    const runner = async (_f: string, _o: Record<string, string>, runId: string) => answerRun(runId)
    const result = await optimize({
      skillDir, trainFilter: 'TRAIN', selFilter: 'SEL', optimizer: { model: 'x/y' },
      outDir: join(root, 'out4'), epochs: 1, stepsPerEpoch: 1, gate: 'pairwise', runner,
    })
    // Score is flat (1.0 both), so only the pairwise verdict can accept it.
    expect(result.steps[0].pairwise).toMatchObject({ b: 1, a: 0 })
    expect(result.steps[0].accepted).toBe(true)
  })
})
