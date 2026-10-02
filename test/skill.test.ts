import { afterEach, describe, it, expect } from 'vitest'
// The captures below are OpenAI-record shaped, which is agentfoo's internal IR
// (see fixture-trace.ts); aliased so the call sites keep reading as "a trace".
import { fixtureTrace as trace } from './fixture-trace.js'
import {
  SkillHandle,
  detectSkillInvocations,
  reasoningReferenceDetector,
  setSkillDetector,
} from '../src/skill.js'
import type { Trace } from '../src/types.js'

/** A minimal trace carrying only reasoning — the hermes-shaped signal (§5). */
function reasoningTrace(reasoning: string): Trace {
  return {
    messages: [{ role: 'assistant', content: '', reasoning }],
    toolCalls: [],
    finalMessage: '',
    raw: [],
    text: () => '',
  }
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

describe('SkillHandle forced mode (TODO §P1)', () => {
  it('throws on calls() instead of a meaningless spy result', () => {
    const traces: Trace[] = []
    const handle = new SkillHandle('frontend-design', '/skills/fd', () => traces, undefined, true)
    traces.push(trace('frontend-design-triggered.jsonl'))
    expect(() => handle.calls()).toThrow(/force: true/)
  })

  it('throws on observedToolCalls() too', () => {
    const traces: Trace[] = []
    const handle = new SkillHandle('frontend-design', '/skills/fd', () => traces, undefined, true)
    traces.push(trace('frontend-design-triggered.jsonl'))
    expect(() => handle.observedToolCalls()).toThrow(/force: true/)
  })

  it('an unforced handle is unaffected (default stays false)', () => {
    const traces: Trace[] = []
    const handle = new SkillHandle('frontend-design', '/skills/fd', () => traces)
    traces.push(trace('frontend-design-triggered.jsonl'))
    expect(() => handle.calls()).not.toThrow()
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

  it('outranks the adapter default, so the global escape hatch still wins', () => {
    const traces: Trace[] = []
    const handle = new SkillHandle('frontend-design', '/skills/fd', () => traces, () => [])
    traces.push(trace('frontend-design-triggered.jsonl'))
    // Adapter default says "never fires"…
    expect(handle.calls()).toHaveLength(0)
    // …until a suite overrides detection globally.
    setSkillDetector(detectSkillInvocations)
    expect(handle.calls()).toHaveLength(1)
  })
})

/**
 * §5: detection is per-agent, not one global guess — the signal differs by agent
 * (opencode fires a real `skill({name})` tool call; hermes preloads skills and
 * only names them in reasoning). Adapters therefore pass their own detector into
 * the handle, so a suite booting two agents grades each with its own signal.
 */
describe('per-agent detector', () => {
  afterEach(() => setSkillDetector(undefined))

  it('is used in place of the built-in guess', () => {
    const traces: Trace[] = []
    const handle = new SkillHandle('frontend-design', '/skills/fd', () => traces, reasoningReferenceDetector)
    traces.push(reasoningTrace('Let me load the frontend-design skill first.'))
    // The built-in heuristic sees no tool call at all here, so a hit proves the
    // adapter's detector ran.
    expect(detectSkillInvocations(traces[0], 'frontend-design')).toHaveLength(0)
    expect(handle.calls()).toHaveLength(1)
    expect(handle.calls()[0].name).toBe('skill:frontend-design')
  })

  it('leaves the built-in guess in place when an adapter ships none', () => {
    const traces: Trace[] = []
    const handle = new SkillHandle('frontend-design', '/skills/fd', () => traces)
    traces.push(trace('frontend-design-triggered.jsonl'))
    expect(handle.calls()).toHaveLength(1)
    expect(handle.calls()[0].name).toBe('skill_view')
  })
})

describe('reasoningReferenceDetector (hermes-shaped signal)', () => {
  it('counts a by-name reference in the turn reasoning', () => {
    const calls = reasoningReferenceDetector(
      reasoningTrace('Let me load the frontend-design skill first since it is preloaded'),
      'frontend-design',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments.via).toBe('reasoning-reference')
  })

  it('stays discriminating: an unrelated turn is not a hit', () => {
    // The negative case must fail for the right reason — reasoning is present
    // and non-empty, it simply never names the skill (TODO §5 caveat).
    const calls = reasoningReferenceDetector(
      reasoningTrace('The user wants the weather. I will call the terminal tool.'),
      'frontend-design',
    )
    expect(calls).toHaveLength(0)
  })
})
