import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parseTrace } from '../src/trace.js'
import { SkillHandle, detectSkillInvocations } from '../src/skill.js'
import type { Trace } from '../src/types.js'

function trace(name: string) {
  const jsonl = readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    'utf8',
  )
  return parseTrace(jsonl)
}

describe('detectSkillInvocations (§11 heuristic)', () => {
  it('detects a skill_view call naming the skill', () => {
    const calls = detectSkillInvocations(trace('frontend-design-triggered.jsonl'), 'frontend-design')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('skill_view')
  })

  it('does not falsely detect the skill in an unrelated trace', () => {
    const calls = detectSkillInvocations(trace('unrelated.jsonl'), 'frontend-design')
    expect(calls).toHaveLength(0)
  })
})

describe('SkillHandle', () => {
  it('aggregates calls across every trace produced after it was loaded', () => {
    const traces: Trace[] = []
    const handle = new SkillHandle('frontend-design', '/skills/frontend-design', () => traces)
    traces.push(trace('unrelated.jsonl'), trace('frontend-design-triggered.jsonl'))
    expect(handle.calls()).toHaveLength(1)
  })

  it('ignores invocations from runs that predate its load (per-test spy scope)', () => {
    // The triggering run happened *before* this handle existed (e.g. a prior
    // test on a file-scoped agent), so it must not be attributed here.
    const traces = [trace('frontend-design-triggered.jsonl')]
    const handle = new SkillHandle('frontend-design', '/skills/frontend-design', () => traces)
    traces.push(trace('unrelated.jsonl'))
    expect(handle.calls()).toHaveLength(0)
  })
})
