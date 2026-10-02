import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { JudgeRecord, Trace, TriggerRecord } from './types.js'
import type { StepTiming, TurnRecord } from './steps.js'
import { normalizeTiming } from './steps.js'
import type { TurnArtifacts } from './agent/types.js'
import type { RunInput, TestInput, TurnInput } from './otel.js'

/**
 * Run artifacts (§9). Every run() drops its normalized trace, the raw hermes
 * session export and the per-step arrival timeline under
 * `.agentfoo/runs/<run-id>/<describe>/<it>/`, because a pass/fail alone is
 * useless for debugging an LLM-driven failure. Written for failed turns too: a
 * turn killed by a timeout, or one that exited non-zero, archives its stream,
 * its timing and `failure.json` even though there is no trace to normalize.
 *
 * The run id is shared across workers and the reporter via `AGENTFOO_RUN_ID`
 * (set by defineConfig), so a single `agentfoo run` writes into one directory
 * even though vitest fans tests out across worker processes.
 */

export function currentRunId(): string {
  return process.env.AGENTFOO_RUN_ID ?? 'local'
}

export function runDir(): string {
  return join(process.cwd(), '.agentfoo', 'runs', currentRunId())
}

/**
 * Make one path segment filesystem-safe. Letters and digits of any script are
 * kept: an ASCII-only filter collapsed every CJK-named test onto the same `_`
 * directory, so their artifacts overwrote each other.
 */
export function sanitize(segment: string): string {
  return segment.replace(/[^\p{L}\p{N}_.\- ]+/gu, '_').trim() || 'unnamed'
}

/**
 * Directory for a single test case inside a *given* run directory.
 *
 * Exists separately from {@link testArtifactDir} because readers that walk a run
 * they were handed (the OTLP export of a recorded run) must not resolve through
 * `AGENTFOO_RUN_ID`: in a fresh CLI process that variable is unset, so the lookup
 * would land on `runs/local` and silently find no turns at all.
 */
export function testDirIn(runDirPath: string, testName: string): string {
  // vitest's currentTestName is "describe > it"; map " > " to nested dirs.
  return join(runDirPath, ...testName.split(/\s*>\s*/).map(sanitize))
}

/** Directory for a single test case, e.g. runs/<id>/<describe>/<it>/. */
export function testArtifactDir(testName: string): string {
  return testDirIn(runDir(), testName)
}

/**
 * Parse one JSON artifact, or `undefined` when it is missing, half-written or
 * hand-edited. Every reader here needs exactly this tolerance, and it used to be
 * spelled out as its own try/catch at each call site.
 */
export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Confusion counts over trigger records (expected = should fire, called = did fire). */
export interface TriggerStats {
  tp: number
  fp: number
  tn: number
  fn: number
  precision: number | null
  recall: number | null
  f1: number | null
}

/** One test as it appears in `report.json`. */
export interface TestReport {
  /** Spec file, relative to the cwd. */
  file: string
  /** Same shape as vitest's `currentTestName` ("describe > it"), the judge-record key. */
  name: string
  state: 'pass' | 'fail' | 'skip'
  duration: number
  /**
   * The string-valued entries of vitest's `task.meta`, which a spec sets from
   * inside the test (`task.meta.split = 'train'`) to tag a case for grouping.
   */
  meta: Record<string, string>
  /** Every trigger assertion in this test: did the skill fire, and was it expected to. */
  triggers: Array<{ skill: string; called: boolean; expected: boolean }>
  /** Every `toSatisfy` grading in this test, in call order; full breakdowns stay in `judge-<n>.json`. */
  judges: Array<{
    index: number
    model: string
    target: JudgeRecord['target']
    threshold: number
    score: number
    /** Number of judge samples averaged into `score`, and their standard deviation. */
    samples: number
    stdev: number
    passed: boolean
    unmet: string[]
  }>
}

/** Pass/fail and mean scores for every test sharing one meta value. */
export interface GroupStats {
  total: number
  passed: number
  failed: number
  skipped: number
  /**
   * Mean score of the i-th `toSatisfy` across the group's tests that reached it.
   * Position is the only stable handle on "which grading": a suite that grades a
   * hard gate first and quality second gets one column per layer. `null` where no
   * test in the group got that far.
   */
  judgeMeans: Array<number | null>
}

/** `meta` key → value → stats. */
export type DatasetGroups = Record<string, Record<string, GroupStats>>

/**
 * `report.json` — the run summary.
 *
 * One type for **both directions** on purpose. The writer (reporter) and the
 * readers (review page, OTLP export backend) each used to declare this shape
 * separately, with the writer taking `unknown` — so a field added on one side
 * silently read as `undefined` on the other, with nothing to catch it.
 */
export interface RunReport {
  runId: string
  passed: number
  failed: number
  skipped: number
  duration?: number
  finishedAt?: string
  /** Which agent this run drove (`-a`), when the suite didn't pin kinds itself. */
  agent?: string
  runtime?: string
  /** Host binary versions actually used under `--local`. */
  agentVersions?: Record<string, string>
  groups?: DatasetGroups
  triggers?: Record<string, TriggerStats>
  tests: TestReport[]
}

/**
 * Archive one turn: the normalized trace, the agent's raw stream, the arrival
 * timeline and the failure reason, each only when there is one.
 *
 * The payload *is* {@link TurnArtifacts} — the same object the adapter handed
 * `onTrace` — plus the turn number. This shape used to be declared a second time
 * here with `timing?: StepRecording`, so the two copies could drift silently.
 */
export function recordTestArtifacts(
  testName: string,
  info: Omit<TurnArtifacts, 'testName'> & { turn: number },
): void {
  const dir = join(testArtifactDir(testName), `turn-${info.turn}`)
  mkdirSync(dir, { recursive: true })
  if (info.trace) {
    writeFileSync(
      join(dir, 'trace.json'),
      JSON.stringify(
        {
          finalMessage: info.trace.finalMessage,
          toolCalls: info.trace.toolCalls,
          messages: info.trace.messages,
        },
        null,
        2,
      ),
    )
  }
  // The agent's own stdout, exactly as it came off the CLI — the capture every
  // envelope fix has been written against. Named neutrally because it is not
  // hermes-specific: this same file is what pinned opencode's part stream and
  // pi's ACP frames. Written even for a failed turn: an empty or truncated
  // stream is itself the finding.
  writeFileSync(join(dir, 'agent-session.jsonl'), info.sessionJsonl)
  if (info.timeline) {
    // `timing.json` is the summary a human reads; `timing.jsonl` is every frame
    // with its arrival time, so a 37-minute turn can be re-read step by step
    // instead of guessed at (see src/steps.ts).
    writeFileSync(join(dir, 'timing.json'), JSON.stringify(info.timeline.summary, null, 2))
    if (info.timeline.frames.length) {
      writeFileSync(
        join(dir, 'timing.jsonl'),
        info.timeline.frames.map((f) => JSON.stringify(f)).join('\n') + '\n',
      )
    }
  }
  if (info.failure) {
    writeFileSync(join(dir, 'failure.json'), JSON.stringify(info.failure, null, 2))
  }
}

const JUDGE_FILE = /^judge-\d+\.json$/

/** Gradings already recorded per test in this worker, for `judge-<n>` numbering. */
const judgeCounts = new Map<string, number>()

/** Next 1-based grading index for `testName` (a test never spans workers). */
export function nextJudgeIndex(testName: string): number {
  const n = (judgeCounts.get(testName) ?? 0) + 1
  judgeCounts.set(testName, n)
  return n
}

/**
 * Persist one `toSatisfy` grading. Written on pass *and* fail: a score that
 * only exists inside a failure message makes a 0.71 scrape-by indistinguishable
 * from a 1.00, and leaves nothing to aggregate across a dataset.
 */
export function recordJudgeArtifact(record: JudgeRecord): string {
  const dir = testArtifactDir(record.test)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `judge-${record.index}.json`)
  writeFileSync(path, JSON.stringify(record, null, 2))
  return path
}

/** Every judge record written under a run directory, for the reporter to summarize. */
export function readJudgeArtifacts(dir: string = runDir()): JudgeRecord[] {
  let entries: string[]
  try {
    entries = readdirSync(dir, { recursive: true }) as string[]
  } catch {
    return []
  }
  const records: JudgeRecord[] = []
  for (const rel of entries) {
    if (!JUDGE_FILE.test(basename(rel))) continue
    const record = readJson<JudgeRecord>(join(dir, rel))
    // A half-written or hand-edited file must not take the report down.
    if (record) records.push(record)
  }
  return records.sort((a, b) => a.test.localeCompare(b.test) || a.index - b.index)
}

export function writeRunReport(report: RunReport): string {
  const dir = runDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'report.json')
  writeFileSync(path, JSON.stringify(report, null, 2))
  return path
}

/**
 * Record which agent binary version a `--local` run actually used (TODO §P1.5).
 * Workers merge into one file per run; the reporter copies it into report.json.
 */
export function recordAgentVersion(kind: string, version: string): void {
  const dir = runDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'agent-versions.json')
  // First writer wins; concurrent workers merge into the file they find.
  const all: Record<string, string> = readJson<Record<string, string>>(path) ?? {}
  all[kind] = version
  writeFileSync(path, JSON.stringify(all, null, 2))
}

export function readAgentVersions(dir: string = runDir()): Record<string, string> | undefined {
  return readJson<Record<string, string>>(join(dir, 'agent-versions.json'))
}

const TRIGGER_FILE = /^trigger-\d+\.json$/
const triggerCounts = new Map<string, number>()

/** Persist one trigger assertion next to the test's other artifacts. */
export function recordTriggerArtifact(r: Omit<TriggerRecord, 'index' | 'recordedAt'>): void {
  const index = (triggerCounts.get(r.test) ?? 0) + 1
  triggerCounts.set(r.test, index)
  const dir = testArtifactDir(r.test)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `trigger-${index}.json`), JSON.stringify({ ...r, index, recordedAt: new Date().toISOString() }, null, 2))
}

/** Every trigger record written under a run directory. */
export function readTriggerArtifacts(dir: string = runDir()): TriggerRecord[] {
  let entries: string[]
  try {
    entries = readdirSync(dir, { recursive: true }) as string[]
  } catch {
    return []
  }
  const out: TriggerRecord[] = []
  for (const rel of entries) {
    if (!TRIGGER_FILE.test(basename(rel))) continue
    const record = readJson<TriggerRecord>(join(dir, rel))
    if (record) out.push(record)
  }
  return out.sort((a, b) => a.test.localeCompare(b.test) || a.index - b.index)
}

/** One test's recorded turns, as the OTLP exporter needs them (see otel.ts). */
function readTurns(testDir: string): Array<{ index: number; summary: StepTiming; timelinePath?: string }> {
  let entries: string[]
  try {
    entries = readdirSync(testDir)
  } catch {
    return []
  }
  const turns: Array<{ index: number; summary: StepTiming; timelinePath?: string }> = []
  for (const entry of entries) {
    const match = /^turn-(\d+)$/.exec(entry)
    if (!match) continue
    const timingPath = join(testDir, entry, 'timing.json')
    if (!existsSync(timingPath)) continue
    const timeline = join(testDir, entry, 'timing.jsonl')
    // `normalizeTiming` also bridges the pre-grouping shape, so archived runs
    // stay readable; a half-written file yields nothing and is skipped.
    const summary = normalizeTiming(readJson<unknown>(timingPath))
    if (!summary) continue
    turns.push({
      index: Number(match[1]),
      summary,
      ...(existsSync(timeline) ? { timelinePath: timeline } : {}),
    })
  }
  return turns.sort((a, b) => a.index - b.index)
}

/**
 * Read a finished run back off disk in the shape {@link file://./otel.ts exportRun}
 * consumes (§9 → protocol). `undefined` when the run has no `report.json`, which
 * is the honest answer for a run still in flight.
 *
 * Absolute placement is derived, exactly as `planRunSpans` documents: the run
 * spans `finishedAt - duration`, tests are laid out back to back inside it (they
 * run serially — `fileParallelism: false`), and each test's turns are laid out
 * back to back inside *that*. Per-turn durations are measured; their offsets
 * within a test are not, and the exporter marks the run span accordingly.
 */
export function readRunForExport(dir: string = runDir()): RunInput | undefined {
  const report = readJson<RunReport>(join(dir, 'report.json'))
  if (!report) return undefined

  const endMs = report.finishedAt ? Date.parse(report.finishedAt) : Date.now()
  const startMs = endMs - (report.duration ?? 0)
  let cursor = startMs

  const tests: TestInput[] = (report.tests ?? []).map((t) => {
    const testStart = cursor
    cursor += t.duration ?? 0
    let turnCursor = testStart
    const turns: TurnInput[] = readTurns(testDirIn(dir, t.name)).map((turn) => {
      const withStart: TurnInput = { ...turn, startMs: turnCursor }
      turnCursor += turn.summary.totalMs
      return withStart
    })
    return {
      name: t.name,
      ...(t.file ? { file: t.file } : {}),
      ...(t.state ? { state: t.state } : {}),
      durationMs: t.duration ?? 0,
      startMs: testStart,
      ...(t.triggers ? { triggers: t.triggers } : {}),
      ...(t.judges ? { judges: t.judges } : {}),
      turns,
    }
  })

  return {
    runId: report.runId ?? 'local',
    ...(report.agent ? { agent: report.agent } : {}),
    ...(report.runtime ? { runtime: report.runtime } : {}),
    startMs,
    endMs,
    ...(report.passed !== undefined ? { passed: report.passed } : {}),
    ...(report.failed !== undefined ? { failed: report.failed } : {}),
    ...(report.skipped !== undefined ? { skipped: report.skipped } : {}),
    ...(report.triggers ? { triggers: report.triggers } : {}),
    tests,
  }
}

/** Confusion counts over trigger records (expected = should fire, called = did fire). */
export function triggerStats(records: TriggerRecord[]): TriggerStats {
  let tp = 0, fp = 0, tn = 0, fn = 0
  for (const r of records) {
    if (r.expected && r.called) tp++
    else if (!r.expected && r.called) fp++
    else if (!r.expected && !r.called) tn++
    else fn++
  }
  const precision = tp + fp ? tp / (tp + fp) : null
  const recall = tp + fn ? tp / (tp + fn) : null
  const f1 = precision !== null && recall !== null && precision + recall ? (2 * precision * recall) / (precision + recall) : null
  return { tp, fp, tn, fn, precision, recall, f1 }
}
