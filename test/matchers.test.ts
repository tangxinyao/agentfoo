import { describe, it, expect } from 'vitest'
// Importing agentfoo registers the custom matchers as a side effect.
import 'agentfoo'
import { fixtureTrace } from './fixture-trace.js'
import { SkillHandle } from '../src/skill.js'
import type { Trace } from '../src/types.js'

function handleFor(fixtureName: string): SkillHandle {
  // Mirror real usage: the handle is loaded first, then a run appends its trace,
  // so it falls inside the handle's spy window (traces since load).
  const traces: Trace[] = []
  const handle = new SkillHandle('frontend-design', '/skills/frontend-design', () => traces)
  traces.push(fixtureTrace(fixtureName))
  return handle
}

describe('spy matchers', () => {
  it('toHaveBeenCalled passes when the skill fired', () => {
    expect(handleFor('frontend-design-triggered.jsonl')).toHaveBeenCalled()
  })

  it('not.toHaveBeenCalled passes when the skill did not fire', () => {
    expect(handleFor('unrelated.jsonl')).not.toHaveBeenCalled()
  })

  it('toHaveBeenCalledWith matches on argument subset', () => {
    expect(handleFor('frontend-design-triggered.jsonl')).toHaveBeenCalledWith({
      name: 'frontend-design',
    })
  })

  it('toHaveBeenCalledWith fails on a non-matching argument', () => {
    expect(handleFor('frontend-design-triggered.jsonl')).not.toHaveBeenCalledWith({
      name: 'git-commit',
    })
  })

  it('rejects a non-skill target with a helpful error', () => {
    expect(() => expect('not a skill').toHaveBeenCalled()).toThrow(/skill handle/)
  })
})
