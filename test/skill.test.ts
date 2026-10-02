import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'
import { parseTrace } from '../src/trace.js'
import { SkillHandle, detectSkillInvocations, setSkillDetector } from '../src/skill.js'
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

  it('exposes every observed tool call in-window for failure diagnostics', () => {
    const traces: Trace[] = []
    const handle = new SkillHandle('frontend-design', '/skills/frontend-design', () => traces)
    traces.push(trace('unrelated.jsonl'))
    // The unrelated trace has tool calls, none of which are the skill firing.
    expect(handle.calls()).toHaveLength(0)
    expect(handle.observedToolCalls().length).toBeGreaterThan(0)
  })
})

describe('setSkillDetector', () => {
  afterEach(() => setSkillDetector(undefined))

  it('replaces the built-in heuristic for SkillHandle.calls()', () => {
    const traces: Trace[] = []
    const handle = new SkillHandle('anything', '/skills/anything', () => traces)
    traces.push(trace('unrelated.jsonl'))
    // Default heuristic finds nothing; a custom detector that claims every tool
    // call is the skill flips the result, proving the override is consulted.
    expect(handle.calls()).toHaveLength(0)
    setSkillDetector((t) => t.toolCalls)
    expect(handle.calls()).toEqual(traces[0].toolCalls)
  })
})
