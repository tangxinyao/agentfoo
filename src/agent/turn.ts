import { progress, withHeartbeat } from '../progress.js'
import { StepRecorder, timingSummary } from '../steps.js'
import type { SplitQuality, TurnRecord } from '../steps.js'
import type { Trace } from '../types.js'
import type { ExecResult, RuntimeEnv } from '../runtime/types.js'
import type { TurnArtifacts } from './types.js'
import { turnTimedOut } from './shared.js'

/**
 * The one turn pipeline every adapter runs (§timeout, §9).
 *
 * This used to be copy-pasted into `AcpxAgent.run`, `OpencodeAgent.run` and
 * `CommandAgent.run` — including the invariant below, which was repeated as a
 * comment three times and therefore got implemented wrong once. In the copy that
 * was wrong, the throws sat *above* the archive, so a killed turn left only
 * `report.json` on disk (live-verified 2026-10-01). Now there is exactly one
 * place for that ordering to be right.
 *
 * Two functions rather than one, because the split is where the real seam is:
 *
 * - {@link execTurn} runs the child under a heartbeat and timestamps its stream.
 * - {@link finishTurn} interprets the result — parse best-effort, archive, *then*
 *   throw — and is the only place the archive ordering is expressed.
 *
 * Everything an adapter varies is a parameter: which decoder reads the envelope,
 * how a non-zero exit is explained, and what "a turn that produced nothing" means
 * for that agent.
 */

/** Heartbeat cadence and suspension detection live in progress.ts (one policy). */

export interface TurnExec {
  /** Heartbeat line, e.g. `acpx hermes run: "…"`. */
  label: string
  argv: string[]
  env: RuntimeEnv
  /** Credentials/environment forwarded to the exec. */
  execEnv: Record<string, string>
  /** Adapter-enforced bound: a turn must not outlive its own test (TODO §timeout). */
  timeoutMs?: number
  /** Whether this envelope brackets tool calls; forwarded to the recorder. */
  splitQuality?: SplitQuality
  /**
   * Rewrite raw stdout into the stream everything downstream sees. ACP agents
   * that restate a growing tool input per token need this before the bytes reach
   * the trace, the archive or the timing split (see steps.ts).
   */
  compact?: (stdout: string) => string
}

export interface TurnOutcome {
  result: ExecResult
  recording: TurnRecord
  /** Post-compaction bytes: what gets parsed and archived. Adapters may replace it. */
  stream: string
}

/** Exec one turn under a heartbeat, timestamping every frame as it arrives. */
export async function execTurn(spec: TurnExec): Promise<TurnOutcome> {
  const recorder = new StepRecorder(spec.splitQuality ? { splitQuality: spec.splitQuality } : {})
  const started = Date.now()
  const result = await withHeartbeat(
    spec.label,
    () =>
      spec.env.exec(spec.argv, {
        env: spec.execEnv,
        timeoutMs: spec.timeoutMs,
        onStdoutChunk: (chunk, atMs) => recorder.feed(chunk, atMs),
      }),
    // Host-level suspensions (Modern Standby etc.) go into the timeline rather
    // than silently inflating the model/tool split (TODO §timeout).
    { onSuspend: (lostMs) => recorder.addSuspended(lostMs) },
  )
  const recording = recorder.finish({
    totalMs: Date.now() - started,
    exitCode: result.exitCode,
    ...(result.timedOut ? { timedOut: true } : {}),
  })
  const stream = spec.compact ? spec.compact(result.stdout) : result.stdout
  if (spec.compact && stream.length < result.stdout.length) {
    progress(`  compacted stream: ${mib(result.stdout.length)} → ${mib(stream.length)}`)
  }
  return { result, recording, stream }
}

export interface TurnFinish {
  /** Same label/argv[0] the exec used, for the timeout and exit messages. */
  label: string
  prompt: string
  timeoutMs?: number
  /** Decode {@link TurnOutcome.stream}. Throws when the envelope is unrecognized. */
  parse: (stream: string) => Trace
  /** Hand the turn's artifacts to whoever archives them (the fixture layer). */
  archive: (artifacts: TurnArtifacts) => void
  /** Successful turns join the spy window; failed ones must not (see AcpxAgent.run). */
  remember?: (trace: Trace) => void
  /** Explanation for a non-zero exit — may probe a provider, hence possibly async. */
  exitMessage: (result: ExecResult) => Promise<string> | string
  /**
   * A step that failed *after* the exec but before parsing (e.g. hermes' session
   * export). Rethrown once the archive is on disk, so a broken export still
   * leaves the record behind.
   */
  deferredError?: Error
  /** Drop the session: a killed or non-zero turn must not be continued. */
  onBadTurn?: () => void
  /**
   * Reject a turn that parsed cleanly but produced nothing (see `isSilentTurn`).
   * Returns the error message, or `undefined` when the turn is fine.
   */
  verify?: (trace: Trace, result: ExecResult) => Promise<string | undefined> | string | undefined
}

/**
 * Parse, archive, then translate a bad outcome into a throw — in that order.
 *
 * Archive before *any* throw: a non-zero exit or a killed turn is exactly the
 * case whose stream explains the failure, and by the time we throw the test may
 * already be gone (its own timeout fired while the turn was still running, and
 * vitest drops the late rejection), so this archive is the only surviving
 * evidence.
 */
export async function finishTurn(outcome: TurnOutcome, spec: TurnFinish): Promise<Trace> {
  const { result, recording } = outcome
  const { exitCode, timedOut } = result
  const output = result.stderr || result.stdout

  let trace: Trace | undefined
  let parseError: Error | undefined
  try {
    trace = spec.parse(outcome.stream)
  } catch (err) {
    parseError = err as Error
  }
  if (trace) {
    progress(`  trace: ${trace.messages.length} messages, ${trace.toolCalls.length} tool calls`)
    // Only a *successful* turn joins the spy window: SkillHandle credits every
    // trace pushed after a handle was created to that handle, so a killed or
    // non-zero turn's trace would be seen by the *next* test's negative
    // assertion. It is still archived below and recorded in `failure.json`.
    if (exitCode === 0 && !timedOut) spec.remember?.(trace)
  }
  if (recording.summary.frames.seen) progress(`  ${timingSummary(recording.summary)}`)
  spec.archive({
    ...(trace ? { trace } : {}),
    sessionJsonl: outcome.stream,
    timeline: recording,
    ...(exitCode !== 0 || timedOut ? { failure: { exitCode, ...(timedOut ? { timedOut } : {}) } } : {}),
  })

  if (timedOut) {
    spec.onBadTurn?.()
    throw turnTimedOut(spec.label, spec.prompt, spec.timeoutMs ?? 0, output)
  }
  if (exitCode !== 0) {
    spec.onBadTurn?.()
    throw new Error(await spec.exitMessage(result))
  }
  if (spec.deferredError) throw spec.deferredError
  if (!trace) throw parseError ?? new Error(`${spec.label} produced an unrecognized stream`)
  if (spec.verify) {
    const problem = await spec.verify(trace, result)
    if (problem) throw new Error(problem)
  }
  return trace
}

/** Bytes as whole MiB/MB, for the compaction line. */
export function mib(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)}MB`
}
