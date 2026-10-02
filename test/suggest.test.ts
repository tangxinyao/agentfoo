import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JudgeRecord } from '../src/types.js'

// The optimizer is a network model: replay canned responses in call order and
// capture every prompt it was sent.
const calls: Array<{ system: string; user: string }> = []
const replies: unknown[] = []
vi.mock('../src/judge.js', () => ({
  completeJson: async (_cfg: unknown, system: string, user: string) => {
    calls.push({ system, user })
    return replies.shift()
  },
}))

const { applyEdits, loadEvidence, minibatches, suggest } = await import('../src/suggest.js')

const SKILL = `---
name: demo
description: demo skill
---

# Demo

## Rules

1. Be accurate.
2. Use analogies.
`

describe('applyEdits', () => {
  it('applies the four ops against exact, unique anchors', () => {
    const { skill, results } = applyEdits(SKILL, [
      { op: 'insert_after', anchor: '1. Be accurate.', content: '   - State the conditions a law holds under.', rationale: '' },
      { op: 'replace', old: '2. Use analogies.', content: '2. Use analogies, then say where they break.', rationale: '' },
      { op: 'append', content: '## Checklist\n\n- [ ] Conditions stated', rationale: '' },
      { op: 'delete', old: '# Demo\n\n', rationale: '' },
    ])
    expect(results.every((r) => r.applied)).toBe(true)
    expect(skill).toContain('1. Be accurate.\n   - State the conditions a law holds under.\n2.')
    expect(skill).toContain('then say where they break.')
    expect(skill.trimEnd().endsWith('- [ ] Conditions stated')).toBe(true)
    expect(skill).not.toContain('# Demo')
  })

  it('skips — never guesses — missing, ambiguous and frontmatter anchors', () => {
    const { skill, results } = applyEdits(SKILL, [
      { op: 'replace', old: 'not in the skill', content: 'x', rationale: '' },
      { op: 'replace', old: 'demo', content: 'x', rationale: '' },
      { op: 'replace', old: 'description: demo skill', content: 'description: better', rationale: '' },
    ])
    expect(results.map((r) => r.reason)).toEqual([
      'anchor text not found in the skill',
      'anchor text is ambiguous (2 matches)',
      'edits to the frontmatter are out of scope',
    ])
    expect(skill).toBe(SKILL)
  })

  it('applies later edits against the result of earlier ones', () => {
    const { results } = applyEdits(SKILL, [
      { op: 'replace', old: '2. Use analogies.', content: '2. Use one analogy.', rationale: '' },
      { op: 'replace', old: '2. Use analogies.', content: 'x', rationale: '' },
    ])
    expect(results.map((r) => r.applied)).toEqual([true, false])
  })
})

describe('protected slow-update region', () => {
  it('rejects step edits that touch it, and optimize writes it idempotently', async () => {
    const { withSlowBlock } = await import('../src/optimize.js')
    const withBlock = withSlowBlock(SKILL, '- keep it short')
    expect(withSlowBlock(withBlock, '- keep it shorter').match(/SLOW_UPDATE_START/g)).toHaveLength(1)
    const { results } = applyEdits(withBlock, [
      { op: 'replace', old: '- keep it short', content: '- anything', rationale: '' },
      { op: 'replace', old: '2. Use analogies.', content: '2. Use one analogy.', rationale: '' },
    ])
    expect(results.map((r) => r.applied)).toEqual([false, true])
    expect(results[0].reason).toMatch(/slow-update region/)
  })
})

describe('minibatches', () => {
  it('chunks in order', () => {
    expect(minibatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
})

describe('suggest', () => {
  let root: string
  let skillDir: string
  let runPath: string

  const judge = (test: string, unmet: string[]): JudgeRecord => ({
    test,
    index: 1,
    model: 'deepseek/x',
    target: 'string',
    threshold: 1,
    score: unmet.length ? 0.5 : 1,
    passed: !unmet.length,
    breakdown: [
      { criteria: 'ok', weight: 1, met: true, reason: '' },
      ...unmet.map((c) => ({ criteria: c, weight: 1, met: false, reason: `missing: ${c}` })),
    ],
    samples: 1,
    scores: [unmet.length ? 0.5 : 1],
    stdev: 0,
    gradedAt: '',
  })

  function writeCase(name: string, answer: string, unmet: string[]) {
    const dir = join(runPath, name.replace(/[^\p{L}\p{N}_.\- ]+/gu, '_').trim())
    mkdirSync(join(dir, 'turn-1'), { recursive: true })
    mkdirSync(join(dir, 'turn-3'), { recursive: true })
    writeFileSync(join(dir, 'turn-1', 'trace.json'), JSON.stringify({ finalMessage: 'stale' }))
    writeFileSync(join(dir, 'turn-3', 'trace.json'), JSON.stringify({ finalMessage: answer }))
    writeFileSync(join(dir, 'judge-1.json'), JSON.stringify(judge(name, unmet)))
  }

  beforeEach(() => {
    calls.length = 0
    replies.length = 0
    root = mkdtempSync(join(tmpdir(), 'agentfoo-suggest-'))
    skillDir = join(root, 'skill')
    runPath = join(root, 'run')
    mkdirSync(skillDir)
    mkdirSync(runPath)
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL)
    writeCase('[train/concept] entropy', '熵就是混乱', ['states the isolated-system condition'])
    writeCase('[train/article] sky', 'Rayleigh…', [])
    writeFileSync(
      join(runPath, 'report.json'),
      JSON.stringify({
        tests: [
          { name: '[train/concept] entropy', state: 'fail', meta: { split: 'train' } },
          { name: '[train/article] sky', state: 'pass', meta: { split: 'train' } },
          { name: '[train/article] skipped', state: 'skip' },
        ],
      }),
    )
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reads the last turn and the unmet criteria with the judge’s reasons', () => {
    const [entropy, sky] = loadEvidence(runPath)
    expect(entropy).toMatchObject({ state: 'fail', finalMessage: '熵就是混乱', meta: { split: 'train' } })
    expect(entropy.judges[0].unmet).toEqual([
      { criteria: 'states the isolated-system condition', reason: 'missing: states the isolated-system condition' },
    ])
    expect(sky.judges[0].unmet).toEqual([])
  })

  it('reflects on failures and successes separately, clips to budget, and writes outputs without touching SKILL.md', async () => {
    const good = { op: 'replace', old: '1. Be accurate.', content: '1. Be accurate; state when a law holds.', rationale: 'conditions' }
    replies.push(
      { failure_summary: [{ pattern: 'omits scope of laws', count: 1 }], edits: [good] },
      { preserve: ['2. Use analogies.'] },
      { edits: [{ ...good, support: 1 }, { op: 'append', content: 'extra', rationale: 'over budget' }] },
    )

    const out = join(root, 'out')
    const result = await suggest({ skillDir, runPath, optimizer: { model: 'deepseek/x' }, budget: 1, outDir: out })

    expect(calls[0].system).toMatch(/^You are an expert failure analyst/)
    expect(calls[1].system).toMatch(/^You are analyzing PASSING/)
    expect(calls[2].system).toMatch(/^You are consolidating proposed edits/)
    expect(calls[0].user).toContain('熵就是混乱')
    expect(calls[0].user).not.toContain('Rayleigh')
    expect(calls[1].user).toContain('Rayleigh')
    expect(calls[2].user).toContain('2. Use analogies.')

    expect(result.edits).toHaveLength(1)
    expect(result.results[0].applied).toBe(true)
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toBe(SKILL)
    expect(readFileSync(join(out, 'SKILL.suggested.md'), 'utf8')).toContain('state when a law holds')
    expect(readFileSync(join(out, 'SKILL.md.diff'), 'utf8')).toContain('+1. Be accurate; state when a law holds.')
    expect(readFileSync(join(out, 'suggestions.md'), 'utf8')).toContain('omits scope of laws')
  })

  it('refuses a run with nothing failed', async () => {
    writeFileSync(join(runPath, 'report.json'), JSON.stringify({ tests: [{ name: '[train/article] sky', state: 'pass' }] }))
    await expect(
      suggest({ skillDir, runPath, optimizer: { model: 'x' }, outDir: join(root, 'out') }),
    ).rejects.toThrow(/No failed tests/)
  })
})
