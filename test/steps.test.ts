import { describe, expect, it } from 'vitest'
import { StepRecorder, normalizeTiming, timingSummary } from '../src/steps.js'

/**
 * The step timeline exists because a 37-minute turn used to be a black box: the
 * stream carried no arrival times, so "the model was slow", "a tool ran for
 * minutes" and "acpx restarted the agent mid-turn" were indistinguishable after
 * the fact. These tests pin the split, the classification and the buffering —
 * all offline, on synthetic frames shaped like the two real envelopes (ACP and
 * opencode's part stream).
 */

const acp = (update: Record<string, unknown>): string =>
  JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update } })

const toolCall = (id: string, title: string): string =>
  acp({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'read' })

const toolDone = (id: string): string =>
  acp({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' })

const message = (text: string): string =>
  acp({ sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text }] })

const turnEnd = (): string => JSON.stringify({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } })

describe('StepRecorder', () => {
  it('timestamps every frame and splits the silence between the agent and its tools', () => {
    const r = new StepRecorder()
    r.feed(`${message('working')}\n`, 2_000) // first frame at 2s: model latency
    r.feed(`${toolCall('t1', 'read: SKILL.md')}\n`, 3_000) // 1s of agent time
    r.feed(`${toolDone('t1')}\n`, 8_000) // 5s inside the tool
    r.feed(`${turnEnd()}\n`, 9_000) // 1s of agent time

    const { frames, summary } = r.finish({ totalMs: 9_500, exitCode: 0 })

    expect(frames.map((f) => f.kind)).toEqual(['message', 'tool_call', 'tool_done', 'turn_end'])
    expect(frames.map((f) => f.gapMs)).toEqual([2_000, 1_000, 5_000, 1_000])
    expect(summary.firstFrameMs).toBe(2_000)
    expect(summary.split.toolMs).toBe(5_000)
    expect(summary.split.agentMs).toBe(4_000)
    expect(summary.totalMs).toBe(9_500)
    expect(summary.frames).toEqual({ seen: 4, retained: 4, truncated: 0 })
    expect(summary.exit).toEqual({ code: 0 })
    // The longest silence is named by what preceded it, which is the whole point:
    // "5s after the read tool call" is actionable, "5s" alone is not.
    expect(summary.longest[0]).toMatchObject({ gapMs: 5_000, after: 'tool_call', afterDetail: 'read: SKILL.md' })
  })

  it('holds a partial line until its newline arrives, then files the whole line at that moment', () => {
    const r = new StepRecorder()
    const line = `${toolCall('t9', 'bash')}\n`
    r.feed(line.slice(0, 20), 100) // no newline yet → nothing recorded
    r.feed(line.slice(20), 250)

    const { frames, summary } = r.finish({ totalMs: 300 })

    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ kind: 'tool_call', tMs: 250, gapMs: 250 })
    expect(summary.split.agentMs).toBe(250)
  })

  it('classifies opencode-style part frames with the same vocabulary', () => {
    const r = new StepRecorder()
    r.feed(`${JSON.stringify({ type: 'text', part: { text: 'hi' } })}\n`, 10)
    r.feed(`${JSON.stringify({ type: 'tool_use', part: { tool: 'bash' } })}\n`, 20)
    r.feed(`${JSON.stringify({ type: 'tool_result', part: { tool: 'bash', state: { status: 'completed' } } })}\n`, 30)

    const { frames } = r.finish({ totalMs: 40 })

    expect(frames.map((f) => f.kind)).toEqual(['message', 'tool_call', 'tool_done'])
  })

  it('keeps unrecognized lines on the timeline instead of dropping their silence', () => {
    const r = new StepRecorder()
    r.feed('not json at all\n', 1_000)
    r.feed(`${message('ok')}\n`, 4_000)

    const { frames, summary } = r.finish({ totalMs: 4_000 })

    expect(frames.map((f) => f.kind)).toEqual(['other', 'message'])
    expect(summary.split.agentMs).toBe(4_000)
  })

  it('records a trailing line with no newline without attributing time to it', () => {
    const r = new StepRecorder()
    r.feed(`${message('ok')}\n`, 500)
    r.feed('{"truncated":', 900)

    const { frames } = r.finish({ totalMs: 1_000 })

    expect(frames).toHaveLength(2)
    expect(frames[1].tMs).toBe(500) // not 900: the time belongs to the frame it followed
    expect(frames[1].gapMs).toBe(0)
  })

  it('surfaces a failure turn in its summary', () => {
    const r = new StepRecorder()
    r.feed(`${toolCall('t1', 'bash')}\n`, 1_000)
    const { summary } = r.finish({ totalMs: 2_000, exitCode: 137, timedOut: true })

    expect(summary.exit).toEqual({ code: 137, timedOut: true })
    expect(summary.frames.seen).toBe(1)
    expect(timingSummary(summary)).toContain('2.0s') // smoke: the line is printable
  })

  it('caps the retained frames while keeping every frame in the accounting', () => {
    const r = new StepRecorder()
    const total = 20_050 // just past the retention cap
    for (let i = 1; i <= total; i++) r.feed(`${message('x')}\n`, i * 10)

    const { frames, summary } = r.finish({ totalMs: total * 10 })

    // A pathologically chatty stream (pi restates a growing tool input per
    // token) must not turn into a ~150MB artifact, but the split stays complete.
    expect(summary.frames.seen).toBe(total)
    expect(frames.length).toBeLessThan(total)
    expect(summary.frames.truncated).toBe(total - frames.length)
    expect(summary.split.agentMs).toBe(total * 10)
  })

  it('counts an inline-envelope tool window as mixed, not as pure model time', () => {
    // opencode's shape: the tool frame arrives already carrying its result, so
    // no interval ever opens and the window is model *and* tool together.
    const r = new StepRecorder({ splitQuality: 'coarse' })
    r.feed(`${JSON.stringify({ type: 'step_start', part: { type: 'step-start' } })}\n`, 1_000)
    r.feed(
      `${JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'bash', state: { status: 'completed' } } })}\n`,
      6_000,
    )

    const { summary } = r.finish({ totalMs: 6_000 })

    expect(summary.split.quality).toBe('coarse')
    expect(summary.split.mixedMs).toBe(5_000)
    expect(summary.split.toolMs).toBe(0)
    expect(summary.split.agentMs).toBe(1_000)
    expect(timingSummary(summary)).toContain('不可细分')
  })

  it('stops charging model time to a tool that never reported completion', () => {
    const r = new StepRecorder()
    // hermes' `write:` calls send only this frame — 21 of 55 in one real turn.
    r.feed(`${toolCall('w1', 'write: index.html')}\n`, 1_000)
    r.feed(`${message('next')}\n`, 31_000)
    r.feed(`${message('and')}\n`, 33_000)

    const { summary } = r.finish({ totalMs: 33_000 })

    expect(summary.split.unclosedTools).toBe(1)
    // The 30s window is the model's next step: before the message-frame rule it
    // was charged to a `write` that had already finished (~50s on a 740s turn).
    expect(summary.split.toolMs).toBe(0)
    expect(summary.split.agentMs).toBe(33_000)
  })

  it('keeps host suspension out of the model/tool split entirely', () => {
    const r = new StepRecorder()
    r.feed(`${message('hi')}\n`, 1_000)
    r.addSuspended(1_362_000) // the measured pi freeze, 2026-10-01

    const { summary } = r.finish({ totalMs: 1_400_000 })

    expect(summary.suspendedMs).toBe(1_362_000)
    expect(summary.split.agentMs).toBe(1_000)
    expect(timingSummary(summary)).toContain('系统挂起')
  })
})

/**
 * `timing.json` is persisted, so a shape change cannot invalidate the runs
 * already on disk: the reader bridges the pre-grouping flat shape. When the last
 * flat file stops being worth reading, this goes with it.
 */
describe('normalizeTiming', () => {
  it('passes the grouped shape through untouched', () => {
    const r = new StepRecorder()
    r.feed(`${message('hi')}\n`, 1_000)
    const { summary } = r.finish({ totalMs: 2_000, exitCode: 0 })

    expect(normalizeTiming(JSON.parse(JSON.stringify(summary)))).toEqual(summary)
  })

  it('upgrades a flat pre-grouping summary', () => {
    const flat = {
      totalMs: 740_000,
      firstFrameMs: 2_200,
      frames: 225,
      agentMs: 99_100,
      toolMs: 639_900,
      splitQuality: 'exact',
      unclosedTools: 21,
      longest: [{ tMs: 2_200, gapMs: 2_200, after: 'exec_start' }],
      exitCode: 0,
      framesTruncated: 25,
      framesFrom: 'raw stdout',
    }

    const t = normalizeTiming(flat)!

    expect(t.split).toEqual({ agentMs: 99_100, toolMs: 639_900, quality: 'exact', unclosedTools: 21 })
    expect(t.frames).toEqual({ seen: 225, retained: 200, truncated: 25 })
    expect(t.exit).toEqual({ code: 0 })
    expect(t.longest).toHaveLength(1)
  })

  it('rejects anything that is not a timing summary', () => {
    expect(normalizeTiming(undefined)).toBeUndefined()
    expect(normalizeTiming('not json')).toBeUndefined()
    expect(normalizeTiming({ nope: true })).toBeUndefined()
  })
})
