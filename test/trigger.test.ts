import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import 'agentfoo'
import { SkillHandle, skillFileReadDetector } from '../src/skill.js'
import { readTriggerArtifacts, runDir, triggerStats } from '../src/artifacts.js'
import type { Trace, TriggerRecord } from '../src/types.js'

const read = (name: string): Trace => ({
  messages: [],
  toolCalls: [{ name: 'read', arguments: { path: `/skills/${name}/SKILL.md` }, rawArguments: JSON.stringify({ path: `/skills/${name}/SKILL.md` }) }],
  raw: [],
  finalMessage: '',
  text: () => '',
})
const silent: Trace = { messages: [], toolCalls: [], raw: [], finalMessage: '', text: () => '' }
function handle(trace: Trace) {
  const traces: Trace[] = []
  const h = new SkillHandle('demo', '/skills/demo', () => traces, skillFileReadDetector)
  traces.push(trace)
  return h
}

describe('trigger records', () => {
  beforeEach(() => (process.env.AGENTFOO_RUN_ID = `unit-trg-${randomUUID().slice(0, 8)}`))
  afterEach(() => {
    rmSync(runDir(), { recursive: true, force: true })
    delete process.env.AGENTFOO_RUN_ID
  })

  it('records what fired and what was expected, for both polarities', () => {
    expect(handle(read('demo'))).toHaveBeenCalled()
    expect(handle(silent)).not.toHaveBeenCalled()
    expect(() => expect(handle(read('demo'))).not.toHaveBeenCalled()).toThrow()
    const recs = readTriggerArtifacts()
    expect(recs.map((r) => [r.called, r.expected])).toEqual([[true, true], [false, false], [true, false]])
  })
})

describe('triggerStats', () => {
  it('computes precision, recall and F1', () => {
    const r = (expected: boolean, called: boolean) => ({ expected, called }) as TriggerRecord
    const s = triggerStats([r(true, true), r(true, true), r(true, false), r(false, true), r(false, false)])
    expect(s).toMatchObject({ tp: 2, fn: 1, fp: 1, tn: 1 })
    expect(s.precision).toBeCloseTo(2 / 3)
    expect(s.recall).toBeCloseTo(2 / 3)
    expect(s.f1).toBeCloseTo(2 / 3)
    expect(triggerStats([r(false, false)]).precision).toBeNull()
  })
})
