import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { readRunForExport, runDir, testArtifactDir } from '../src/artifacts.js'
import { trace } from '@opentelemetry/api'
import type { TracerProvider } from '@opentelemetry/api'
import { exportRun, planRunSpans, spanTree } from '../src/otel.js'
import type { RunInput } from '../src/otel.js'
import { buildWaterfall } from '../src/waterfall.js'
import { STALLS_KEPT } from '../src/steps.js'
import type { StepTiming } from '../src/steps.js'

/**
 * OTLP mapping and export (§9 → protocol). Everything here is offline: the plan
 * is a pure function, and the export is driven by an injected fake api, because
 * `@opentelemetry/api` is an *optional* peer that this repo (and a consumer who
 * doesn't use telemetry) may not have installed at all.
 */

function timing(over: Partial<StepTiming> = {}): StepTiming {
  return {
    totalMs: 10_000,
    firstFrameMs: 2_000,
    frames: { seen: 100, retained: 100, truncated: 0 },
    split: { agentMs: 4_000, toolMs: 6_000, quality: 'exact' },
    longest: [
      { tMs: 3_000, gapMs: 2_000, after: 'tool_call', afterDetail: 'terminal: npm test' },
      { tMs: 9_000, gapMs: 500, after: 'message' },
    ],
    ...over,
  }
}

function runInput(over: Partial<RunInput> = {}): RunInput {
  return {
    runId: '2026-10-02T02-38-03',
    agent: 'hermes',
    runtime: 'docker',
    startMs: 1_000_000,
    endMs: 1_060_000,
    passed: 1,
    failed: 0,
    skipped: 0,
    triggers: { 'frontend-design': { tp: 1, fp: 0, tn: 1, fn: 0, precision: 1, recall: 1, f1: 1 } },
    tests: [
      {
        name: 'triggers on a UI design request',
        file: 'skills/frontend-design/frontend-design.spec.ts',
        state: 'pass',
        durationMs: 40_000,
        startMs: 1_000_000,
        triggers: [{ skill: 'frontend-design', called: true, expected: true }],
        judges: [{ index: 1, score: 1, threshold: 0.7, passed: true, model: 'deepseek/deepseek-flash' }],
        turns: [{ index: 1, startMs: 1_002_000, summary: timing(), timelinePath: '/runs/x/turn-1/timing.jsonl' }],
      },
    ],
    ...over,
  }
}

describe('planRunSpans', () => {
  it('maps one run to a root invoke_agent span carrying the dataset-level triggers', () => {
    const spans = planRunSpans(runInput())
    const run = spans.find((s) => s.key === 'run')!
    expect(run.parentKey).toBeUndefined()
    expect(run.name).toBe('invoke_agent hermes')
    expect(run.startMs).toBe(1_000_000)
    expect(run.endMs).toBe(1_060_000)
    expect(run.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'hermes',
      'agentfoo.run.id': '2026-10-02T02-38-03',
      'agentfoo.tests.passed': 1,
      // precision/recall are dataset properties, not trace properties — OTLP has
      // no table type, so they ride on the run span as attributes.
      'agentfoo.trigger.frontend-design.precision': '1.000',
      'agentfoo.trigger.frontend-design.tn': 1,
    })
  })

  it('nests a test span under the run and a turn span under the test', () => {
    const spans = planRunSpans(runInput())
    const test = spans.find((s) => s.key === 'test:0')!
    const turn = spans.find((s) => s.key === 'test:0:turn:1')!
    expect(test.parentKey).toBe('run')
    expect(turn.parentKey).toBe('test:0')
    expect(test.attributes['agentfoo.test.name']).toBe('triggers on a UI design request')
    expect(turn.startMs + 10_000).toBe(turn.endMs)
  })

  it('puts the model/tool split on the turn span, including the coarse and failure cases', () => {
    const spans = planRunSpans(
      runInput({
        tests: [
          {
            name: 'opencode coarse',
            state: 'pass',
            durationMs: 20_000,
            startMs: 1_000_000,
            turns: [
              {
                index: 1,
                startMs: 1_000_000,
                summary: timing({
                  split: {
                    agentMs: 10_000,
                    toolMs: 0,
                    mixedMs: 130_000,
                    quality: 'coarse',
                    unclosedTools: 21,
                  },
                  suspendedMs: 1_362_000,
                  frames: { seen: 49_556, retained: 20_000, truncated: 29_556 },
                  exit: { code: 137, timedOut: true },
                }),
              },
            ],
          },
        ],
      }),
    )
    const turn = spans.find((s) => s.key === 'test:0:turn:1')!
    expect(turn.attributes).toMatchObject({
      'agentfoo.split_quality': 'coarse',
      'agentfoo.mixed_ms': 130_000,
      'agentfoo.unclosed_tools': 21,
      'agentfoo.suspended_ms': 1_362_000,
      'agentfoo.frames_truncated': 29_556,
      'agentfoo.exit_code': 137,
      'agentfoo.timed_out': true,
    })
    expect(turn.status?.code).toBe(2)
  })

  it('exports only the longest stalls as events, never the frame timeline', () => {
    const longest = Array.from({ length: 9 }, (_, i) => ({
      tMs: 1_000 * (i + 1),
      gapMs: 9_000 - i * 1_000,
      after: 'tool_call' as const,
      afterDetail: `cmd ${i}`,
    }))
    const spans = planRunSpans(
      runInput({
        tests: [
          {
            name: 't',
            state: 'pass',
            durationMs: 1_000,
            startMs: 1_000_000,
            turns: [
              {
                index: 1,
                startMs: 1_000_000,
                summary: timing({
                  longest,
                  frames: { seen: 49_556, retained: 49_556, truncated: 0 },
                }),
                timelinePath: '/runs/x/turn-1/timing.jsonl',
              },
            ],
          },
        ],
      }),
    )
    const turn = spans.find((s) => s.key === 'test:0:turn:1')!
    expect(turn.events).toHaveLength(STALLS_KEPT)
    expect(turn.events.every((e) => e.name === 'agentfoo.stall')).toBe(true)
    // Absolute placement: the event carries the turn offset plus the gap offset.
    expect(turn.events[0].timeMs).toBe(1_000_000 + 1_000)
    expect(turn.events[0].attributes['agentfoo.stall.gap_ms']).toBe(9_000)
    // The 49,556-frame timeline is *referenced*, not shipped.
    expect(turn.attributes['agentfoo.timeline_path']).toBe('/runs/x/turn-1/timing.jsonl')
    expect(turn.attributes['agentfoo.frames']).toBe(49_556)
  })

  it('carries judge gradings and trigger records as events on the test span', () => {
    const spans = planRunSpans(runInput())
    const test = spans.find((s) => s.key === 'test:0')!
    expect(test.events.map((e) => e.name)).toEqual(['agentfoo.trigger', 'agentfoo.judge'])
    expect(test.events[1].attributes).toMatchObject({
      'agentfoo.judge.score': 1,
      'agentfoo.judge.threshold': 0.7,
      'gen_ai.request.model': 'deepseek/deepseek-flash',
    })
  })

  it('marks a failing run so a dashboard can filter on status', () => {
    const spans = planRunSpans(runInput({ passed: 0, failed: 2 }))
    expect(spans.find((s) => s.key === 'run')!.status?.code).toBe(2)
  })
})

describe('spanTree', () => {
  const tree = spanTree(planRunSpans(runInput()))

  it('finds the root, the children and a whole subtree in one index', () => {
    expect(tree.root()!.key).toBe('run')
    expect(tree.childrenOf('run').map((s) => s.key)).toEqual(['test:0'])
    expect(tree.subtree('test:0').map((s) => s.key)).toEqual(['test:0', 'test:0:turn:1'])
  })

  it('finds a test span by name rather than by position', () => {
    // The review page lists only non-skipped tests, so its indices cannot be used
    // as plan indices — this lookup is why.
    expect(tree.testSpan('triggers on a UI design request')!.key).toBe('test:0')
    expect(tree.testSpan('not in this run')).toBeUndefined()
  })

  it('is empty rather than throwing for an unknown key', () => {
    expect(tree.subtree('nope')).toEqual([])
    expect(tree.childrenOf('nope')).toEqual([])
  })
})

/**
 * The waterfall geometry used to live inside the session page's `<script>`, where
 * only "does it parse" was testable. It is a pure function of the span plan now.
 */
describe('buildWaterfall', () => {
  const waterfall = buildWaterfall(planRunSpans(runInput()))

  it('lays out every span as a percentage of the whole run', () => {
    const [run, test, turn] = waterfall.rows
    expect(waterfall.totalMs).toBe(60_000)
    expect(waterfall.spanCount).toBe(3)

    expect(run).toMatchObject({ kind: 'run', depth: 0, leftPct: 0, widthPct: 100, durationMs: 60_000 })
    // The test starts with the run and lasts 40s of its 60s.
    expect(test).toMatchObject({ kind: 'test', depth: 1, leftPct: 0 })
    expect(test.widthPct).toBeCloseTo((100 * 40_000) / 60_000, 5)
    // The turn starts 2s in and lasts 10s.
    expect(turn).toMatchObject({ kind: 'turn', depth: 2 })
    expect(turn.leftPct).toBeCloseTo((100 * 2_000) / 60_000, 5)
    expect(turn.widthPct).toBeCloseTo((100 * 10_000) / 60_000, 5)
  })

  it('splits a turn bar by model/tool/mixed, as percentages of that turn', () => {
    const turn = waterfall.rows[2]
    // The fixture turn is agent 4s / tool 6s.
    expect(turn.segments).toEqual([
      { kind: 'agent', pct: 40 },
      { kind: 'tool', pct: 60 },
    ])
    // Non-turn rows have nothing to split.
    expect(waterfall.rows[0].segments).toEqual([])
  })

  it('positions stall markers inside their own row, with a readable title', () => {
    const turn = waterfall.rows[2]
    // The fixture's first stall is 3s into a 10s turn.
    expect(turn.events[0].leftPct).toBe(30)
    expect(turn.events[0].title).toContain('2000ms after tool_call')
    expect(turn.events).toHaveLength(2)
  })

  it('flags a failed span and keeps its attributes printable', () => {
    const failed = buildWaterfall(
      planRunSpans(
        runInput({
          passed: 0,
          failed: 1,
          tests: [
            {
              name: 'boom',
              state: 'fail',
              durationMs: 1_000,
              startMs: 1_000_000,
              turns: [],
            },
          ],
        }),
      ),
    )
    expect(failed.rows[0].failed).toBe(true)
    expect(failed.rows[0].attributes).toContainEqual(['agentfoo.tests.failed', '1'])
  })

  it('renders nothing at all for a run with no spans', () => {
    expect(buildWaterfall([])).toEqual({ rows: [], totalMs: 0, spanCount: 0 })
  })
})

/** One recorded api call, from {@link fakeApi}. */
interface FakeCall {
  name: string
  startTime?: number
  endTime?: number
  parented: boolean
  attributes: Record<string, unknown>
  events: Array<{ name: string; attributes?: Record<string, unknown>; startTime?: number }>
  status?: { code: number }
}

/** Minimal fake of the api slice: records every call, never touches the network. */
function fakeProvider(opts: { failOn?: number } = {}): { provider: TracerProvider; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const record = (): FakeCall => ({ name: '', parented: false, attributes: {}, events: [] })
  let nth = 0
  const provider = {
    getTracer: () => ({
      startSpan(
        name: string,
        options?: { startTime?: number; attributes?: Record<string, unknown> },
        ctx?: unknown,
      ) {
        if (opts.failOn !== undefined && nth++ === opts.failOn) throw new Error('boom')
        const entry = record()
        entry.name = name
        entry.startTime = options?.startTime
        entry.parented = ctx !== undefined
        entry.attributes = { ...(options?.attributes ?? {}) }
        calls.push(entry)
        const span = {
          setAttribute(k: string, v: unknown) {
            entry.attributes[k] = v
            return span
          },
          setStatus(s: { code: number }) {
            entry.status = s
            return span
          },
          addEvent(n: string, a?: Record<string, unknown>, at?: number) {
            entry.events.push({ name: n, attributes: a, startTime: at })
            return span
          },
          end(t?: number) {
            entry.endTime = t
          },
        }
        return span
      },
    }),
  }
  return { provider: provider as unknown as TracerProvider, calls }
}

describe('exportRun', () => {
  const originalOpt = process.env.AGENTFOO_OTEL
  afterEach(() => {
    if (originalOpt === undefined) delete process.env.AGENTFOO_OTEL
    else process.env.AGENTFOO_OTEL = originalOpt
    trace.disable()
  })

  it('honours the opt-out before touching the api', () => {
    process.env.AGENTFOO_OTEL = '0'
    const { provider, calls } = fakeProvider()
    trace.setGlobalTracerProvider(provider)
    const outcome = exportRun(runInput())
    expect(outcome.skipped).toBe('AGENTFOO_OTEL=0')
    expect(calls).toHaveLength(0)
  })

  it('starts parents before children, links them, and ends every span', () => {
    const { provider, calls } = fakeProvider()
    trace.setGlobalTracerProvider(provider)

    const outcome = exportRun(runInput())

    expect(outcome.spans).toBe(3)
    expect(calls.map((c) => c.name)).toEqual([
      'invoke_agent hermes',
      'invoke_agent hermes · triggers on a UI design request',
      'agentfoo.turn 1',
    ])
    // The root has no parent; both children do.
    expect(calls[0].parented).toBe(false)
    expect(calls[1].parented).toBe(true)
    expect(calls[2].parented).toBe(true)
    // Absolute times survive the trip (the fake records what it was handed).
    expect(calls[0].startTime).toBe(1_000_000)
    expect(calls[0].endTime).toBe(1_060_000)
    expect(calls[2].endTime).toBe(1_002_000 + 10_000)
    expect(calls[2].events.map((e) => e.name)).toEqual(['agentfoo.stall', 'agentfoo.stall'])
    // The event's own timestamp is the stall instant (turn start + offset), not
    // export time — otherwise a backend plots every stall at the span's tail.
    expect(calls[2].events[0].startTime).toBe(1_002_000 + 3_000)
    expect(calls[2].events[0].attributes).toMatchObject({ 'agentfoo.stall.gap_ms': 2_000 })
  })

  it('still walks the plan when no provider is registered: the api makes those spans non-recording', () => {
    trace.disable()
    expect(exportRun(runInput())).toEqual({ spans: 3 })
  })

  it('keeps the rest of the tree when one span cannot be created', () => {
    const { provider, calls } = fakeProvider({ failOn: 1 })
    trace.setGlobalTracerProvider(provider)

    const outcome = exportRun(runInput())

    expect(outcome.spans).toBe(2) // run + turn; the test span was lost
    expect(calls.map((c) => c.name)).toEqual(['invoke_agent hermes', 'agentfoo.turn 1'])
  })
})

describe('readRunForExport', () => {
  it('rebuilds the export input from a run directory, deriving turn placement', () => {
    const runId = `unit-${randomUUID().slice(0, 8)}`
    process.env.AGENTFOO_RUN_ID = runId
    const dir = runDir()
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'report.json'),
        JSON.stringify({
          runId,
          agent: 'hermes',
          duration: 30_000,
          finishedAt: '2026-10-02T02:00:30.000Z',
          passed: 1,
          failed: 0,
          skipped: 0,
          tests: [{ name: 'a turn', state: 'pass', duration: 20_000 }],
        }),
      )
      const turnDir = join(testArtifactDir('a turn'), 'turn-1')
      mkdirSync(turnDir, { recursive: true })
      writeFileSync(join(turnDir, 'timing.json'), JSON.stringify(timing({ totalMs: 5_000 })))
      writeFileSync(join(turnDir, 'timing.jsonl'), '{}\n')

      // Reproduce the `agentfoo otel` process, where AGENTFOO_RUN_ID is unset.
      // Turn dirs must resolve from the directory we were handed, never from the
      // env: doing the latter reported "turns 0" in a real export while the
      // reporter's own path (which has the env set) looked fine.
      delete process.env.AGENTFOO_RUN_ID
      const input = readRunForExport(dir)!

      expect(input.agent).toBe('hermes')
      expect(input.endMs - input.startMs).toBe(30_000)
      expect(input.tests).toHaveLength(1)
      expect(input.tests[0].turns).toHaveLength(1)
      // Turns are laid out from their test's start (documented derivation).
      expect(input.tests[0].turns[0].startMs).toBe(input.tests[0].startMs)
      expect(input.tests[0].turns[0].timelinePath).toContain('timing.jsonl')
      expect(input.tests[0].turns[0].summary.totalMs).toBe(5_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      delete process.env.AGENTFOO_RUN_ID
    }
  })

  it('returns undefined for a run with no report yet', () => {
    process.env.AGENTFOO_RUN_ID = `unit-${randomUUID().slice(0, 8)}`
    try {
      expect(readRunForExport()).toBeUndefined()
    } finally {
      delete process.env.AGENTFOO_RUN_ID
    }
  })
})
