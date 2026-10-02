import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import type { AttributeValue, Attributes } from '@opentelemetry/api'
import { STALLS_KEPT } from './steps.js'
import type { StepTiming } from './steps.js'
import { readRunForExport } from './artifacts.js'
import type { TriggerStats } from './artifacts.js'

/**
 * OTLP export (§9 → protocol).
 *
 * The run artifacts are agentfoo's system of record; this module turns them into
 * **standard OpenTelemetry spans** so any OTLP-aware dashboard can read them
 * without knowing anything about agentfoo's file layout. That is the point of
 * being protocol-facing: the format outlives our own UI.
 *
 * Two deliberate choices:
 *
 * 1. **`@opentelemetry/api` is a *required* peer, imported statically.** Not a
 *    dependency: the api's global provider registry is module state, so two
 *    copies of it (which a plain `dependency` invites under pnpm/strict
 *    layouts) mean the app registers a provider in one copy while this module
 *    reads the other — spans silently vanish. A peer guarantees one instance.
 *    Not optional either: this feature exists to be used, and an optional peer
 *    turns "you forgot to install it" into a silent no-op. Everything that
 *    talks to a collector (SDK, exporter, sampler, resource) stays the
 *    consumer's choice — for us, one small setup file next to the suite.
 * 2. **Types come from that package**, so the mapping is checked against the
 *    real `Span`/`Attributes`/`SpanStatusCode` surface instead of a hand-rolled
 *    structural copy of it.
 *
 * Mapping (standard attributes come from the OTel GenAI conventions —
 * `open-telemetry/semantic-conventions-genai`, status **Development**, so they
 * are pinned here rather than pulled from a package that may rename them):
 *
 * | agentfoo            | OTLP                                                        |
 * |---------------------|-------------------------------------------------------------|
 * | one run             | root span `invoke_agent` (one agent interaction)             |
 * | one test            | child span `invoke_agent <agent>` + `agentfoo.test.name`     |
 * | one turn (`turn-N`) | child span `agentfoo.turn` + the model/tool split attributes |
 * | longest silences    | span events `agentfoo.stall` (top 5 only — never per frame)  |
 * | raw frame timeline  | **not exported**; an `agentfoo.timeline_path` attribute      |
 *
 * A model *call* is deliberately not faked as a `gen_ai` `chat` span: ACP does
 * not report per-call boundaries, so the closest honest thing we can derive is
 * the silence the model was responsible for, which is exported as `agentfoo.*`
 * instead of borrowing a standard name we cannot fill in (no per-call tokens).
 */

/** Scope name every span is created under. */
export const OTEL_SCOPE = 'agentfoo'

/** One turn as it exists on disk, plus the absolute time it is placed at. */
export interface TurnInput {
  index: number
  /** The turn's recorded summary — the same shape `timing.json` holds. */
  summary: StepTiming
  /** Absolute epoch ms this turn starts at (laid out by the caller). */
  startMs: number
  /** Path of the full frame timeline, for the attribute back to it. */
  timelinePath?: string
}

/** One test as `report.json` recorded it. */
export interface TestInput {
  name: string
  file?: string
  state?: string
  durationMs: number
  startMs: number
  triggers?: Array<{ skill: string; called: boolean; expected: boolean }>
  judges?: Array<{
    index: number
    score: number
    threshold: number
    passed: boolean
    model?: string
    unmet?: string[]
  }>
  turns: TurnInput[]
  /** Set when the test has no turn artifacts at all. */
  failure?: string
}

export interface RunInput {
  runId: string
  agent?: string
  runtime?: string
  serviceName?: string
  startMs: number
  endMs: number
  passed?: number
  failed?: number
  skipped?: number
  triggers?: Record<string, TriggerStats>
  tests: TestInput[]
}

export interface PlannedEvent {
  name: string
  timeMs: number
  attributes: Record<string, AttributeValue>
}

export interface PlannedSpan {
  /** Stable identity, used to wire parents (and to test the plan). */
  key: string
  parentKey?: string
  name: string
  startMs: number
  endMs: number
  attributes: Record<string, AttributeValue>
  events: PlannedEvent[]
  status?: { code: number; message?: string }
}

const ms = (v: number): number => Math.round(v)

/**
 * Run-level attributes: identity, counts, and the dataset-level trigger stats.
 *
 * Precision/recall belong on the run span because they are a property of the
 * *dataset*, not of one trace — and OTLP has no table type to put them in.
 */
function runAttributes(run: RunInput): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {
    'agentfoo.run.id': run.runId,
    'agentfoo.timeline_derived': true,
    'agentfoo.tests.passed': run.passed ?? 0,
    'agentfoo.tests.failed': run.failed ?? 0,
    'agentfoo.tests.skipped': run.skipped ?? 0,
  }
  if (run.agent) attributes['gen_ai.agent.name'] = run.agent
  if (run.runtime) attributes['agentfoo.runtime'] = run.runtime
  for (const [skill, s] of Object.entries(run.triggers ?? {})) {
    const p = (v: number | null): string => (v === null ? 'n/a' : v.toFixed(3))
    attributes[`agentfoo.trigger.${skill}.precision`] = p(s.precision)
    attributes[`agentfoo.trigger.${skill}.recall`] = p(s.recall)
    attributes[`agentfoo.trigger.${skill}.tp`] = s.tp
    attributes[`agentfoo.trigger.${skill}.fp`] = s.fp
    attributes[`agentfoo.trigger.${skill}.tn`] = s.tn
    attributes[`agentfoo.trigger.${skill}.fn`] = s.fn
  }
  return attributes
}

/** The run's root span: one agent interaction, with the whole dataset's outcome. */
function runSpan(run: RunInput, service: string): PlannedSpan {
  return {
    key: 'run',
    name: `invoke_agent ${run.agent ?? service}`,
    startMs: run.startMs,
    endMs: run.endMs,
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.system': service,
      ...runAttributes(run),
    },
    events: [],
    ...(run.failed
      ? { status: { code: SpanStatusCode.ERROR, message: `${run.failed} test(s) failed` } }
      : {}),
  }
}

/** One test's span. Trigger records and gradings ride along as events. */
function testSpan(run: RunInput, test: TestInput, key: string, service: string): PlannedSpan {
  const attributes: Record<string, AttributeValue> = {
    'gen_ai.operation.name': 'invoke_agent',
    'agentfoo.test.name': test.name,
    'agentfoo.test.state': test.state ?? 'unknown',
    'agentfoo.test.duration_ms': ms(test.durationMs),
  }
  if (test.file) attributes['agentfoo.test.file'] = test.file
  if (run.agent) attributes['gen_ai.agent.name'] = run.agent
  if (test.turns.length === 0) attributes['agentfoo.turns.recorded'] = 0

  const events: PlannedEvent[] = (test.triggers ?? []).map((trigger) => ({
    name: 'agentfoo.trigger',
    timeMs: test.startMs,
    attributes: {
      'agentfoo.skill.name': trigger.skill,
      'agentfoo.trigger.called': trigger.called,
      'agentfoo.trigger.expected': trigger.expected,
    },
  }))
  for (const judge of test.judges ?? []) {
    events.push({
      name: 'agentfoo.judge',
      timeMs: test.startMs + test.durationMs,
      attributes: {
        'agentfoo.judge.index': judge.index,
        'agentfoo.judge.score': judge.score,
        'agentfoo.judge.threshold': judge.threshold,
        'agentfoo.judge.passed': judge.passed,
        ...(judge.model ? { 'gen_ai.request.model': judge.model } : {}),
        ...(judge.unmet?.length ? { 'agentfoo.judge.unmet': judge.unmet } : {}),
      },
    })
  }

  return {
    key,
    parentKey: 'run',
    name: `invoke_agent ${run.agent ?? service} · ${test.name}`,
    startMs: test.startMs,
    endMs: test.startMs + test.durationMs,
    attributes,
    events,
    ...(test.state === 'fail'
      ? { status: { code: SpanStatusCode.ERROR, message: test.failure ?? 'test failed' } }
      : {}),
  }
}

/** One turn's span: the model/tool split, plus its longest silences as events. */
function turnSpan(turn: TurnInput, parentKey: string, key: string): PlannedSpan {
  const t = turn.summary
  const { split, frames, exit } = t
  const attributes: Record<string, AttributeValue> = {
    'agentfoo.turn.index': turn.index,
    'agentfoo.split_quality': split.quality,
    'agentfoo.agent_ms': ms(split.agentMs),
    'agentfoo.tool_ms': ms(split.toolMs),
    'agentfoo.frames': frames.seen,
  }
  if (split.mixedMs !== undefined) attributes['agentfoo.mixed_ms'] = ms(split.mixedMs)
  if (split.unclosedTools !== undefined) attributes['agentfoo.unclosed_tools'] = split.unclosedTools
  if (t.suspendedMs !== undefined) attributes['agentfoo.suspended_ms'] = ms(t.suspendedMs)
  if (frames.truncated > 0) attributes['agentfoo.frames_truncated'] = frames.truncated
  if (t.firstFrameMs !== undefined) attributes['agentfoo.first_frame_ms'] = ms(t.firstFrameMs)
  if (exit?.code !== undefined) attributes['agentfoo.exit_code'] = exit.code
  if (exit?.timedOut) attributes['agentfoo.timed_out'] = true
  // The full per-frame timeline stays on disk: a pi turn is 49,556 frames
  // (measured), and no collector should be asked to hold that per span.
  if (turn.timelinePath) attributes['agentfoo.timeline_path'] = turn.timelinePath

  return {
    key,
    parentKey,
    name: `agentfoo.turn ${turn.index}`,
    startMs: turn.startMs,
    endMs: turn.startMs + t.totalMs,
    attributes,
    // Only the longest silences become events, never the frame timeline.
    events: t.longest.slice(0, STALLS_KEPT).map((gap) => ({
      name: 'agentfoo.stall',
      timeMs: turn.startMs + gap.tMs,
      attributes: {
        'agentfoo.stall.gap_ms': ms(gap.gapMs),
        'agentfoo.stall.after': gap.after,
        ...(gap.afterDetail ? { 'agentfoo.stall.after_detail': gap.afterDetail } : {}),
      },
    })),
    ...(exit?.timedOut || (exit?.code !== undefined && exit.code !== 0)
      ? {
          status: {
            code: SpanStatusCode.ERROR,
            message: exit.timedOut ? 'turn timed out' : `exit ${exit.code}`,
          },
        }
      : {}),
  }
}

/**
 * Build the whole span tree for a run. Pure: no clock, no I/O, no api — which is
 * what makes the mapping testable offline and reusable for backfilling recorded
 * runs.
 *
 * Turn *placement* is derived, not measured: `timing.json` records a turn's
 * duration but not the instant it began, so turns are laid out back to back from
 * their test's start (and tests back to back from the run's start). Suites run
 * serially (`fileParallelism: false`), so this is faithful for the common case;
 * the run span carries `agentfoo.timeline_derived` so a reader never mistakes it
 * for measured wall-clock placement.
 */
export function planRunSpans(run: RunInput): PlannedSpan[] {
  const service = run.serviceName ?? 'agentfoo'
  const spans: PlannedSpan[] = [runSpan(run, service)]
  run.tests.forEach((test, ti) => {
    const testKey = `test:${ti}`
    spans.push(testSpan(run, test, testKey, service))
    for (const turn of test.turns) {
      spans.push(turnSpan(turn, testKey, `${testKey}:turn:${turn.index}`))
    }
  })
  return spans
}

/**
 * A plan indexed into the tree shape its consumers keep re-deriving.
 *
 * Built in one pass rather than scanned per lookup: the review server and the
 * session page both need "the test span for this name" and "everything under
 * it", and each was answering that with its own filter/find chain over the array.
 */
export interface SpanTree {
  byKey: Map<string, PlannedSpan>
  root(): PlannedSpan | undefined
  childrenOf(key: string): PlannedSpan[]
  /** The test span carrying this `agentfoo.test.name` (matched by name, not index). */
  testSpan(name: string): PlannedSpan | undefined
  /** A span and every descendant of it, parents first. */
  subtree(key: string): PlannedSpan[]
}

export function spanTree(spans: PlannedSpan[]): SpanTree {
  const byKey = new Map(spans.map((s) => [s.key, s]))
  const children = new Map<string, PlannedSpan[]>()
  for (const span of spans) {
    if (!span.parentKey) continue
    const list = children.get(span.parentKey)
    if (list) list.push(span)
    else children.set(span.parentKey, [span])
  }
  const childrenOf = (key: string): PlannedSpan[] => children.get(key) ?? []
  const subtree = (key: string): PlannedSpan[] => {
    const root = byKey.get(key)
    if (!root) return []
    return [root, ...childrenOf(key).flatMap((child) => subtree(child.key))]
  }
  return {
    byKey,
    root: () => spans.find((s) => !s.parentKey),
    childrenOf,
    // A test span is a child of the run that carries a test name; the run span
    // itself has no such attribute, so it can never match.
    testSpan: (name) => spans.find((s) => s.parentKey !== undefined && s.attributes['agentfoo.test.name'] === name),
    subtree,
  }
}

export interface ExportOutcome {
  /** Spans handed to the api (0 and a reason when there is nothing to do). */
  spans: number
  /** Why nothing was emitted. A closed set: free text here is unreportable. */
  skipped?: 'AGENTFOO_OTEL=0'
}

/**
 * Emit a prepared plan through whatever provider the consumer registered.
 *
 * Separated from {@link planRunSpans} so the mapping can be inspected, tested and
 * rendered (the session page does exactly that) without an api or a provider
 * anywhere near it.
 *
 * Never throws: telemetry is an output, and an output that can fail a test run is
 * worse than no output. With no provider registered — no SDK wired up yet — every
 * span is a no-op by construction, which is the api's design rather than a silent
 * failure of ours.
 */
export function emitSpans(plan: PlannedSpan[]): number {
  const tracer = trace.getTracer(OTEL_SCOPE, '0.1.1')
  const started = new Map<string, ReturnType<typeof tracer.startSpan>>()
  let count = 0
  // The plan is ordered parents-first, so one pass suffices.
  for (const planned of plan) {
    try {
      const parent = planned.parentKey ? started.get(planned.parentKey) : undefined
      // Explicit parent rather than an active-context dance: it works whether or
      // not the consumer's SDK installed an async context manager.
      const ctx = parent ? trace.setSpan(context.active(), parent) : undefined
      const span = tracer.startSpan(
        planned.name,
        { startTime: planned.startMs, attributes: planned.attributes },
        ctx,
      )
      for (const event of planned.events) {
        // The event's own timestamp carries *when* (backends plot on it); the
        // attributes carry *what*.
        span.addEvent(event.name, event.attributes, event.timeMs)
      }
      if (planned.status) span.setStatus(planned.status)
      span.end(planned.endMs)
      started.set(planned.key, span)
      count++
    } catch {
      // One malformed span must not lose the rest of the tree.
    }
  }
  return count
}

/** Plan a run's spans and hand them to the registered provider. */
export function exportRun(run: RunInput): ExportOutcome {
  if (process.env.AGENTFOO_OTEL === '0') return { spans: 0, skipped: 'AGENTFOO_OTEL=0' }
  return { spans: emitSpans(planRunSpans(run)) }
}

/** What {@link exportRecordedRun} did, in the shape a CLI wants to print. */
export interface RunExportSummary {
  runId: string
  agent?: string
  tests: number
  turns: number
  spans: number
  skipped?: ExportOutcome['skipped']
}

/**
 * Read a recorded run directory and export it — the `agentfoo otel` verb minus
 * argument parsing and printing, so the behaviour is testable without a CLI.
 */
export function exportRecordedRun(dir: string): RunExportSummary {
  const input = readRunForExport(dir)
  if (!input) throw new Error(`${dir} has no report.json yet (still in flight?)`)
  const outcome = exportRun(input)
  return {
    runId: input.runId,
    ...(input.agent ? { agent: input.agent } : {}),
    tests: input.tests.length,
    turns: input.tests.reduce((n, t) => n + t.turns.length, 0),
    spans: outcome.spans,
    ...(outcome.skipped ? { skipped: outcome.skipped } : {}),
  }
}
