import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `agentfoo score` — measure a suite before trying to improve against it
 * (TODO §P2.5 roadmap step 1). The whole suite runs `repeat` times; every case
 * gets a pass count, the mean and spread of its score, and the same per-tag
 * groups as `report.json`. One run can't tell a real regression from a coin
 * flip — both the agent's answer and the judge's grading vary — and the spread
 * measured here is also the right `--margin` for `agentfoo optimize`.
 */

export interface CaseScore {
  name: string
  meta: Record<string, string>
  runs: number
  passes: number
  /** Per-run score: mean of the test's gradings; a gradeless test is 1 if it passed, else 0. */
  scores: number[]
  mean: number
  stdev: number
}

export interface ScoreResult {
  runs: string[]
  cases: CaseScore[]
  /** Mean over cases of each case's mean score, with the run-to-run stdev of the suite-level score. */
  overall: { mean: number; stdev: number; passRate: number }
  /** meta key → value → mean score and pass rate across that group's cases. */
  groups: Record<string, Record<string, { cases: number; mean: number; passRate: number }>>
}

interface ReportTest {
  name: string
  state: string
  meta?: Record<string, string>
  judges: Array<{ score: number }>
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)
const stdev = (xs: number[]) => {
  const m = mean(xs)
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)))
}

function testScore(t: ReportTest): number {
  return t.judges.length ? mean(t.judges.map((j) => j.score)) : t.state === 'pass' ? 1 : 0
}

/** Aggregate finished runs of the same suite into per-case and per-group statistics. */
export function aggregateRuns(runPaths: string[]): ScoreResult {
  const byCase = new Map<string, CaseScore>()
  const suiteScores: number[] = []
  for (const runPath of runPaths) {
    const report = JSON.parse(readFileSync(join(runPath, 'report.json'), 'utf8')) as { tests?: ReportTest[] }
    const tests = (report.tests ?? []).filter((t) => t.state !== 'skip')
    suiteScores.push(mean(tests.map(testScore)))
    for (const t of tests) {
      const c = byCase.get(t.name) ?? { name: t.name, meta: t.meta ?? {}, runs: 0, passes: 0, scores: [], mean: 0, stdev: 0 }
      c.runs++
      if (t.state === 'pass') c.passes++
      c.scores.push(testScore(t))
      if (!Object.keys(c.meta).length && t.meta) c.meta = t.meta
      byCase.set(t.name, c)
    }
  }
  const cases = [...byCase.values()].map((c) => ({ ...c, mean: mean(c.scores), stdev: stdev(c.scores) }))

  const groups: ScoreResult['groups'] = {}
  const acc: Record<string, Record<string, CaseScore[]>> = {}
  for (const c of cases) {
    for (const [k, v] of Object.entries(c.meta)) ((acc[k] ??= {})[v] ??= []).push(c)
  }
  for (const [k, byValue] of Object.entries(acc)) {
    groups[k] = {}
    for (const [v, cs] of Object.entries(byValue)) {
      groups[k][v] = {
        cases: cs.length,
        mean: mean(cs.map((c) => c.mean)),
        passRate: cs.reduce((s, c) => s + c.passes, 0) / cs.reduce((s, c) => s + c.runs, 0),
      }
    }
  }

  return {
    runs: runPaths,
    cases,
    overall: {
      mean: mean(cases.map((c) => c.mean)),
      stdev: stdev(suiteScores),
      passRate: cases.reduce((s, c) => s + c.passes, 0) / Math.max(1, cases.reduce((s, c) => s + c.runs, 0)),
    },
    groups,
  }
}

export function formatScore(r: ScoreResult): string {
  const lines = [
    `  suite score ${r.overall.mean.toFixed(3)} ± ${r.overall.stdev.toFixed(3)} across ${r.runs.length} runs` +
      ` · pass rate ${(100 * r.overall.passRate).toFixed(0)}%`,
    '',
  ]
  for (const [k, byValue] of Object.entries(r.groups)) {
    lines.push(`  by ${k}`)
    for (const [v, g] of Object.entries(byValue).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`    ${v.padEnd(14)} ${g.mean.toFixed(2)}   pass ${(100 * g.passRate).toFixed(0).padStart(3)}%   (${g.cases} cases)`)
    }
  }
  lines.push('', '  flakiest cases (largest spread)')
  for (const c of [...r.cases].sort((a, b) => b.stdev - a.stdev).slice(0, 8)) {
    if (c.stdev === 0) break
    lines.push(`    ${c.mean.toFixed(2)} ± ${c.stdev.toFixed(2)}  ${c.passes}/${c.runs} passed  ${c.name}`)
  }
  return lines.join('\n')
}

/** Run the suite `repeat` times (sequentially — each run already uses the configured concurrency) and aggregate. */
export async function score(opts: {
  repeat: number
  vitestArgs: string[]
  outDir: string
  log?: (m: string) => void
}): Promise<ScoreResult> {
  const log = opts.log ?? (() => {})
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')
  const runs: string[] = []
  for (let i = 1; i <= opts.repeat; i++) {
    const runId = `${stamp}_score-${i}`
    log(`run ${i}/${opts.repeat} → .agentfoo/runs/${runId}`)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'run', ...opts.vitestArgs], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, AGENTFOO_RUN_ID: runId },
      })
      child.on('error', reject)
      child.on('exit', () => resolve()) // failing tests are data, not an error
    })
    const runPath = join(process.cwd(), '.agentfoo', 'runs', runId)
    if (!existsSync(join(runPath, 'report.json'))) throw new Error(`run ${runId} produced no report.json`)
    runs.push(runPath)
  }
  const result = aggregateRuns(runs)
  mkdirSync(opts.outDir, { recursive: true })
  writeFileSync(join(opts.outDir, 'score.json'), JSON.stringify(result, null, 2))
  return result
}
