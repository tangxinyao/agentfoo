import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { JudgeRecord, Trace, TriggerRecord } from './types.js'

/**
 * Run artifacts (§9). Every run() drops its normalized trace and the raw hermes
 * session export under `.agentfoo/runs/<run-id>/<describe>/<it>/`, because a
 * pass/fail alone is useless for debugging an LLM-driven failure.
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

/** Directory for a single test case, e.g. runs/<id>/<describe>/<it>/. */
export function testArtifactDir(testName: string): string {
  // vitest's currentTestName is "describe > it"; map " > " to nested dirs.
  const parts = testName.split(/\s*>\s*/).map(sanitize)
  return join(runDir(), ...parts)
}

export function recordTestArtifacts(
  testName: string,
  info: { trace: Trace; sessionJsonl: string; turn: number },
): void {
  const dir = join(testArtifactDir(testName), `turn-${info.turn}`)
  mkdirSync(dir, { recursive: true })
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
  // The agent's own stdout, exactly as it came off the CLI — the capture every
  // envelope fix has been written against. Named neutrally because it is not
  // hermes-specific: this same file is what pinned opencode's part stream and
  // pi's ACP frames.
  writeFileSync(join(dir, 'agent-session.jsonl'), info.sessionJsonl)
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
    try {
      records.push(JSON.parse(readFileSync(join(dir, rel), 'utf8')) as JudgeRecord)
    } catch {
      // A half-written or hand-edited file must not take the report down.
    }
  }
  return records.sort((a, b) => a.test.localeCompare(b.test) || a.index - b.index)
}

export function writeRunReport(report: unknown): string {
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
  let all: Record<string, string> = {}
  try {
    all = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
  } catch {
    // first writer
  }
  all[kind] = version
  writeFileSync(path, JSON.stringify(all, null, 2))
}

export function readAgentVersions(dir: string = runDir()): Record<string, string> | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'agent-versions.json'), 'utf8')) as Record<string, string>
  } catch {
    return undefined
  }
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
    try {
      out.push(JSON.parse(readFileSync(join(dir, rel), 'utf8')) as TriggerRecord)
    } catch {
      // skip unreadable
    }
  }
  return out.sort((a, b) => a.test.localeCompare(b.test) || a.index - b.index)
}

/** Confusion counts over trigger records (expected = should fire, called = did fire). */
export function triggerStats(records: TriggerRecord[]): {
  tp: number
  fp: number
  tn: number
  fn: number
  precision: number | null
  recall: number | null
  f1: number | null
} {
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
