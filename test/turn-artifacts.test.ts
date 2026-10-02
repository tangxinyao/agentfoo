import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Trace } from '../src/types.js'
import { recordTestArtifacts, runDir, testArtifactDir } from '../src/artifacts.js'
import { StepRecorder } from '../src/steps.js'

/**
 * Failure-path artifacts (TODO §timeout). A turn that exits non-zero, or one
 * killed by the per-turn bound, used to archive *nothing*: the adapter threw
 * before `onTrace` ran, and because the test that asked for it had already timed
 * out, vitest dropped the rejection too. pi's 37-minute turn left literally zero
 * bytes on disk. These tests pin the archive that now always happens.
 */

function fakeTrace(): Trace {
  return {
    messages: [],
    toolCalls: [],
    raw: [],
    finalMessage: 'ok',
    text: () => 'ok',
  }
}

describe('turn artifacts on the failure path', () => {
  beforeEach(() => {
    process.env.AGENTFOO_RUN_ID = `unit-${randomUUID().slice(0, 8)}`
  })
  afterEach(() => {
    rmSync(runDir(), { recursive: true, force: true })
    delete process.env.AGENTFOO_RUN_ID
  })

  it('archives the stream, the timing and the failure reason when the turn produced no trace', () => {
    const recorder = new StepRecorder()
    recorder.feed(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash' } } })}\n`, 1_000)
    const timeline = recorder.finish({ totalMs: 2_000, exitCode: 1 })

    recordTestArtifacts('a failing turn', {
      sessionJsonl: 'RAW STREAM\n',
      turn: 1,
      timeline,
      failure: { exitCode: 1 },
    })

    const dir = join(testArtifactDir('a failing turn'), 'turn-1')
    expect(existsSync(join(dir, 'trace.json'))).toBe(false)
    expect(readFileSync(join(dir, 'agent-session.jsonl'), 'utf8')).toBe('RAW STREAM\n')
    expect(JSON.parse(readFileSync(join(dir, 'timing.json'), 'utf8'))).toMatchObject({
      totalMs: 2_000,
      exit: { code: 1 },
      frames: { seen: 1, retained: 1, truncated: 0 },
    })
    expect(readFileSync(join(dir, 'timing.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, 'failure.json'), 'utf8'))).toEqual({ exitCode: 1 })
  })

  it('records a killed turn as timed out', () => {
    const recorder = new StepRecorder()
    const timeline = recorder.finish({ totalMs: 900_000, exitCode: 137, timedOut: true })

    recordTestArtifacts('a killed turn', {
      sessionJsonl: '',
      turn: 2,
      timeline,
      failure: { exitCode: 137, timedOut: true },
    })

    const dir = join(testArtifactDir('a killed turn'), 'turn-2')
    expect(JSON.parse(readFileSync(join(dir, 'failure.json'), 'utf8'))).toEqual({ exitCode: 137, timedOut: true })
    // An empty stream is itself the finding, so the file still exists.
    expect(readFileSync(join(dir, 'agent-session.jsonl'), 'utf8')).toBe('')
    expect(existsSync(join(dir, 'timing.jsonl'))).toBe(false) // no frames → no per-frame file
  })

  it('still writes trace.json for a successful turn', () => {
    recordTestArtifacts('a good turn', { trace: fakeTrace(), sessionJsonl: 'x', turn: 3 })

    const dir = join(testArtifactDir('a good turn'), 'turn-3')
    expect(existsSync(join(dir, 'trace.json'))).toBe(true)
    expect(existsSync(join(dir, 'failure.json'))).toBe(false)
  })
})
