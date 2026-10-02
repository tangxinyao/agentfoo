import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const proposals: unknown[] = []
const asked: string[] = []
vi.mock('../src/judge.js', () => ({
  completeJson: async (_c: unknown, _s: string, user: string) => {
    asked.push(user)
    return proposals.shift()
  },
}))

const { optimizeDescription, readDescription, withDescription } = await import('../src/optimize-description.js')

describe('frontmatter description', () => {
  it('reads plain, quoted and block-scalar descriptions', () => {
    expect(readDescription('---\nname: x\ndescription: plain text: ok\n---\nbody')).toBe('plain text: ok')
    expect(readDescription('---\nname: x\ndescription: "quoted \\"q\\""\n---\n')).toBe('quoted "q"')
    expect(readDescription('---\nname: x\ndescription: >\n  folded\n  lines\nother: 1\n---\n')).toBe('folded lines')
  })

  it('replaces only the description, safely quoted, keeping the rest', () => {
    const skill = '---\nname: x\ndescription: |\n  old\n  text\nlicense: MIT\n---\n\n# Body: keep\n'
    const out = withDescription(skill, 'Use when: the user says "科普" # not a comment')
    expect(out).toBe('---\nname: x\ndescription: "Use when: the user says \\"科普\\" # not a comment"\nlicense: MIT\n---\n\n# Body: keep\n')
    expect(readDescription(out)).toBe('Use when: the user says "科普" # not a comment')
  })
})

describe('trigger-only mode', () => {
  it('turns toSatisfy into a no-op without calling the judge', async () => {
    await import('agentfoo')
    process.env.AGENTFOO_TRIGGER_ONLY = '1'
    try {
      await expect('anything').toSatisfy('impossible criterion')
    } finally {
      delete process.env.AGENTFOO_TRIGGER_ONLY
    }
  })
})

describe('optimizeDescription', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentfoo-desc-'))
    proposals.length = 0
    asked.length = 0
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** A run whose trigger records follow the skill's description: fires on "article" requests; "concept" too once the description mentions it. */
  function run(runId: string, description: string, cases: Array<[string, boolean]>): string {
    const dir = join(root, 'runs', runId)
    mkdirSync(dir, { recursive: true })
    for (const [name, expected] of cases) {
      const t = join(dir, name)
      mkdirSync(join(t, 'turn-1'), { recursive: true })
      writeFileSync(join(t, 'turn-1', 'trace.json'), JSON.stringify({ finalMessage: 'x', messages: [{ role: 'user', content: `request ${name}` }] }))
      const called = name.startsWith('article') || (name.startsWith('concept') && description.includes('concept'))
      writeFileSync(join(t, 'trigger-1.json'), JSON.stringify({ test: name, index: 1, skill: 'sci', called, expected, recordedAt: '' }))
    }
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ tests: cases.map(([name]) => ({ name, state: 'pass', judges: [] })) }))
    return dir
  }

  it('fixes misses from the train split and accepts only a better selection F1', async () => {
    const skillDir = join(root, 'skill')
    mkdirSync(skillDir)
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: sci\ndescription: writes articles\n---\n\n# Body\n')
    const cases: Array<[string, boolean]> = [['article-1', true], ['concept-1', true], ['code-1', false]]
    const runner = async (_f: string, overrides: Record<string, string>, runId: string) => {
      const skill = readFileSync(join(overrides.sci ?? skillDir, 'SKILL.md'), 'utf8')
      return run(runId, readDescription(skill), cases)
    }
    proposals.push(
      { candidates: [{ description: 'writes articles and explains a concept simply', rationale: 'cover concepts' }, { description: 'worse', rationale: '' }] },
      { candidates: [] },
    )

    const result = await optimizeDescription({
      skillDir, trainFilter: 'T', selFilter: 'S', optimizer: { model: 'x/y' }, outDir: join(root, 'out'), steps: 2, runner,
    })

    expect(result.baseline.f1).toBeCloseTo(2 / 3) // P 1, R 0.5
    expect(result.best.f1).toBe(1)
    expect(result.steps[0].misses.falseNegatives).toEqual(['request concept-1'])
    expect(asked[0]).toContain('request concept-1')
    expect(result.steps[0].accepted).toBe('writes articles and explains a concept simply')
    // Step 2 had no misses left and stopped before asking for more.
    expect(asked).toHaveLength(1)
    expect(readDescription(readFileSync(join(result.bestDir, 'SKILL.md'), 'utf8'))).toBe('writes articles and explains a concept simply')
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toContain('description: writes articles\n')
  })
})
