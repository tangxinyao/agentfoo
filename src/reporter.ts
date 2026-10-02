import { relative } from 'node:path'
import { readAgentVersions, readJudgeArtifacts, readTriggerArtifacts, runDir, triggerStats, writeRunReport } from './artifacts.js'
import type { JudgeRecord, TriggerRecord } from './types.js'

/**
 * Artifact reporter (§9). Runs alongside vitest's default reporter; its only
 * jobs are to write the run summary (`report.json`) and to print the artifacts
 * directory at the end so the path is one click away when debugging.
 */

interface TaskLike {
  type?: string
  mode?: string
  name?: string
  filepath?: string
  result?: { state?: string; duration?: number }
  tasks?: TaskLike[]
  // vitest's `TaskMeta` is an interface without an index signature; `object` keeps
  // real File[] assignable while stringMeta still reads it as a plain record.
  meta?: object
}

interface Totals {
  passed: number
  failed: number
  skipped: number
  duration: number
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
   * inside the test (`task.meta.split = 'train'`) to tag a case for {@link DatasetGroups}.
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

/** meta key → meta value → stats, e.g. `groups.split.train`. */
export type DatasetGroups = Record<string, Record<string, GroupStats>>

function stringMeta(meta: object | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

export function groupTests(tests: TestReport[]): DatasetGroups {
  const groups: DatasetGroups = {}
  const sums: Record<string, Record<string, Array<{ sum: number; n: number }>>> = {}
  for (const t of tests) {
    for (const [key, value] of Object.entries(t.meta)) {
      const g = ((groups[key] ??= {})[value] ??= { total: 0, passed: 0, failed: 0, skipped: 0, judgeMeans: [] })
      g.total++
      if (t.state === 'pass') g.passed++
      else if (t.state === 'fail') g.failed++
      else g.skipped++
      const acc = ((sums[key] ??= {})[value] ??= [])
      t.judges.forEach((j, i) => {
        acc[i] ??= { sum: 0, n: 0 }
        acc[i].sum += j.score
        acc[i].n++
      })
    }
  }
  for (const [key, byValue] of Object.entries(sums)) {
    for (const [value, acc] of Object.entries(byValue)) {
      groups[key][value].judgeMeans = Array.from(acc, (a) => (a ? a.sum / a.n : null))
    }
  }
  return groups
}

function formatGroups(groups: DatasetGroups): string[] {
  const lines: string[] = []
  for (const [key, byValue] of Object.entries(groups)) {
    lines.push(`       by ${key}`)
    for (const [value, g] of Object.entries(byValue).sort(([a], [b]) => a.localeCompare(b))) {
      const means = g.judgeMeans.map((m) => (m === null ? '  -  ' : m.toFixed(2))).join(' ')
      lines.push(`         ${value.padEnd(14)} ${`${g.passed}/${g.total}`.padStart(6)} passed   ${means}`)
    }
  }
  return lines
}

function stateOf(task: TaskLike): TestReport['state'] {
  const state = task.result?.state
  return state === 'pass' ? 'pass' : state === 'fail' ? 'fail' : 'skip'
}

/**
 * Flatten the task tree into tests. `path` accumulates suite names *below* the
 * file, which is exactly how vitest builds `currentTestName` — so a test here and
 * the judge records written from inside it share one key.
 */
export function collectTests(files: TaskLike[], cwd = process.cwd()): Omit<TestReport, 'judges' | 'triggers'>[] {
  const out: Omit<TestReport, 'judges' | 'triggers'>[] = []
  const walk = (tasks: TaskLike[], file: string, path: string[]) => {
    for (const task of tasks) {
      if (task.tasks?.length) {
        walk(task.tasks, file, [...path, task.name ?? ''])
        continue
      }
      out.push({
        file,
        name: [...path, task.name ?? ''].join(' > '),
        state: stateOf(task),
        duration: task.result?.duration ?? 0,
        meta: stringMeta(task.meta),
      })
    }
  }
  for (const f of files) {
    const file = f.filepath ? relative(cwd, f.filepath) : (f.name ?? '')
    walk(f.tasks ?? [], file, [])
  }
  return out
}

export function buildTestReports(
  files: TaskLike[],
  judges: JudgeRecord[],
  cwd = process.cwd(),
  triggers: TriggerRecord[] = [],
): TestReport[] {
  const byTest = new Map<string, JudgeRecord[]>()
  for (const j of judges) byTest.set(j.test, [...(byTest.get(j.test) ?? []), j])
  return collectTests(files, cwd).map((t) => ({
    ...t,
    triggers: triggers
      .filter((r) => r.test === t.name)
      .map((r) => ({ skill: r.skill, called: r.called, expected: r.expected })),
    judges: (byTest.get(t.name) ?? []).map((j) => ({
      index: j.index,
      model: j.model,
      target: j.target,
      threshold: j.threshold,
      score: j.score,
      samples: j.samples ?? 1,
      stdev: j.stdev ?? 0,
      passed: j.passed,
      unmet: j.breakdown.filter((b) => !b.met).map((b) => b.criteria),
    })),
  }))
}

function totalsOf(tests: TestReport[]): Totals {
  const totals: Totals = { passed: 0, failed: 0, skipped: 0, duration: 0 }
  for (const t of tests) {
    if (t.state === 'pass') totals.passed++
    else if (t.state === 'fail') totals.failed++
    else totals.skipped++
    totals.duration += t.duration
  }
  return totals
}

class AgentfooReporter {
  onFinished(files: TaskLike[] = []): void {
    const triggers = readTriggerArtifacts()
    const tests = buildTestReports(files, readJudgeArtifacts(), process.cwd(), triggers)
    const groups = groupTests(tests)
    const bySkill: Record<string, ReturnType<typeof triggerStats>> = {}
    for (const skill of new Set(triggers.map((t) => t.skill))) {
      bySkill[skill] = triggerStats(triggers.filter((t) => t.skill === skill))
    }

    writeRunReport({
      runId: process.env.AGENTFOO_RUN_ID ?? 'local',
      ...totalsOf(tests),
      // Which agent this run drove (`-a`), so an archived run can be read without
      // grepping its artifacts. Unset when the suite pins kinds in its fixtures.
      agent: process.env.AGENTFOO_AGENT,
      runtime: process.env.AGENTFOO_FORCE_LOCAL ? 'local' : undefined,
      // Host binary versions actually used under --local (absent for Docker runs,
      // whose version is the Dockerfile pin).
      agentVersions: readAgentVersions(),
      finishedAt: new Date().toISOString(),
      groups,
      // Per skill: did it fire when (and only when) the suite said it should.
      triggers: bySkill,
      tests,
    })

    const dir = relative(process.cwd(), runDir())
    // eslint-disable-next-line no-console
    console.log(`\n       Logs  ${dir}/`)
    for (const [skill, s] of Object.entries(bySkill)) {
      const pct = (x: number | null) => (x === null ? '–' : `${Math.round(100 * x)}%`)
      // eslint-disable-next-line no-console
      console.log(
        `    trigger  ${skill}: precision ${pct(s.precision)} recall ${pct(s.recall)} ` +
          `(tp ${s.tp} fp ${s.fp} tn ${s.tn} fn ${s.fn})`,
      )
    }
    if (Object.keys(groups).length) {
      // eslint-disable-next-line no-console
      console.log(formatGroups(groups).join('\n'))
    }
    if (process.env.AGENTFOO_FORCE_LOCAL) {
      // eslint-disable-next-line no-console
      console.log(
        '     ⚠︎ ran in LOCAL runtime — results do NOT represent the CI/Docker environment (§3).',
      )
    }
  }
}

/** Reporter instance referenced from defineConfig's `reporters` array. */
export const AGENTFOO_REPORTER = new AgentfooReporter()
