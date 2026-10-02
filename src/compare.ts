import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSkillName } from './agent/shared.js'
import { readTriggerArtifacts, sanitize, triggerStats } from './artifacts.js'
import { completeJson } from './judge.js'
import type { JudgeConfig } from './types.js'

/**
 * `agentfoo compare` — run the same suite with two versions of a skill and ask,
 * case by case, which output is better (TODO §P2.5).
 *
 * Absolute rubric scores answer "does this pass"; they are coarse and noisy for
 * "is B better than A". A pairwise preference is the sharper signal, and it
 * works for both halves of the loop: an LLM judge for the automated side
 * ({@link judgePair}), and a person on the blind side-by-side review page
 * (`agentfoo review --compare`). Version × preference-source are independent
 * axes; this module produces the first and records both.
 */

export type Pick = 'a' | 'b' | 'tie'

export interface PairVerdict {
  /** Final verdict: a side wins only if it won in both presentation orders. */
  winner: Pick
  /** Per-order raw verdicts, [a-first, b-first], for inspecting position bias. */
  orders: [Pick, Pick]
  reasons: [string, string]
}

export interface CompareCase {
  name: string
  meta: Record<string, string>
  prompt: string
  a: string
  b: string
  judge?: PairVerdict
}

export interface CompareResult {
  a: { dir: string; run: string; score: number; trigger?: ReturnType<typeof triggerStats> }
  b: { dir: string; run: string; score: number; trigger?: ReturnType<typeof triggerStats> }
  judgeModel?: string
  cases: CompareCase[]
  summary: PreferenceSummary
}

export interface PreferenceSummary {
  a: number
  b: number
  tie: number
  /** B's share of decisive verdicts, with ties counted half: (b + tie/2) / n. */
  bWinRate: number | null
  /** 95% Wilson interval on bWinRate (ties counted half), or null with no cases. */
  ci: [number, number] | null
}

export function summarize(picks: Pick[]): PreferenceSummary {
  const a = picks.filter((p) => p === 'a').length
  const b = picks.filter((p) => p === 'b').length
  const tie = picks.length - a - b
  const n = picks.length
  if (!n) return { a, b, tie, bWinRate: null, ci: null }
  const p = (b + tie / 2) / n
  const z = 1.96
  const denom = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return { a, b, tie, bWinRate: p, ci: [Math.max(0, centre - half), Math.min(1, centre + half)] }
}

const PAIR_SYSTEM =
  'You compare two responses an AI agent gave to the same user request and decide which ' +
  'one better serves the user. Weigh, in order: factual accuracy (a factual error outweighs ' +
  'style), how well it does what was actually asked (audience, length, format), and clarity. ' +
  'Length is not a merit in itself. If they are genuinely equivalent, say tie. Respond with ' +
  'ONLY a JSON object: {"winner":"1"|"2"|"tie","reason":string}'

/**
 * One pairwise verdict, asked twice with the responses swapped. LLM judges
 * favour a position; a side only wins if it wins both ways, and disagreement
 * between orders becomes a tie rather than noise in the win rate.
 */
export async function judgePair(
  config: JudgeConfig,
  prompt: string,
  a: string,
  b: string,
  criteria?: string,
): Promise<PairVerdict> {
  const ask = async (first: string, second: string) => {
    const r = await completeJson<{ winner?: string; reason?: string }>(
      config,
      PAIR_SYSTEM,
      `# User request\n\n${prompt}\n\n` +
        (criteria ? `# What matters most for this task\n\n${criteria}\n\n` : '') +
        `# Response 1\n\n${first}\n\n# Response 2\n\n${second}`,
    )
    const w = String(r.winner ?? '').trim().toLowerCase()
    return { winner: w === '1' ? 1 : w === '2' ? 2 : 0, reason: r.reason ?? '' }
  }
  const [x, y] = await Promise.all([ask(a, b), ask(b, a)])
  const first: Pick = x.winner === 1 ? 'a' : x.winner === 2 ? 'b' : 'tie'
  const second: Pick = y.winner === 1 ? 'b' : y.winner === 2 ? 'a' : 'tie'
  return { winner: first === second ? first : 'tie', orders: [first, second], reasons: [x.reason, y.reason] }
}

interface ReportTest {
  name: string
  state: string
  meta?: Record<string, string>
  judges?: Array<{ score: number }>
}

/** Final answer and prompt of each test in a run, keyed by test name. */
export function loadAnswers(runPath: string): Map<string, { prompt: string; answer: string; meta: Record<string, string> }> {
  const report = JSON.parse(readFileSync(join(runPath, 'report.json'), 'utf8')) as { tests?: ReportTest[] }
  const out = new Map<string, { prompt: string; answer: string; meta: Record<string, string> }>()
  for (const t of report.tests ?? []) {
    if (t.state === 'skip') continue
    const dir = join(runPath, ...t.name.split(/\s*>\s*/).map(sanitize))
    if (!existsSync(dir)) continue
    const last = readdirSync(dir)
      .filter((f) => /^turn-\d+$/.test(f))
      .sort((x, y) => Number(x.slice(5)) - Number(y.slice(5)))
      .at(-1)
    if (!last) continue
    const trace = JSON.parse(readFileSync(join(dir, last, 'trace.json'), 'utf8')) as {
      finalMessage?: string
      messages?: Array<{ role: string; content: string }>
    }
    out.set(t.name, {
      prompt: trace.messages?.find((m) => m.role === 'user')?.content ?? '',
      answer: trace.finalMessage ?? '',
      meta: t.meta ?? {},
    })
  }
  return out
}

function suiteScore(runPath: string): number {
  const report = JSON.parse(readFileSync(join(runPath, 'report.json'), 'utf8')) as { tests?: ReportTest[] }
  const tests = (report.tests ?? []).filter((t) => t.state !== 'skip')
  const r = tests.map((t) =>
    t.judges?.length ? t.judges.reduce((s, j) => s + j.score, 0) / t.judges.length : t.state === 'pass' ? 1 : 0,
  )
  return r.length ? r.reduce((s, x) => s + x, 0) / r.length : 0
}

/** Pair up two finished runs and (optionally) judge every case both ways. */
export async function compareRuns(opts: {
  aDir: string
  bDir: string
  aRun: string
  bRun: string
  judge?: JudgeConfig
  criteria?: string
  log?: (m: string) => void
}): Promise<CompareResult> {
  const log = opts.log ?? (() => {})
  const A = loadAnswers(opts.aRun)
  const B = loadAnswers(opts.bRun)
  const cases: CompareCase[] = []
  for (const [name, a] of A) {
    const b = B.get(name)
    if (!b || !a.answer.trim() || !b.answer.trim()) continue
    cases.push({ name, meta: a.meta, prompt: a.prompt, a: a.answer, b: b.answer })
  }
  if (opts.judge) {
    let i = 0
    for (const c of cases) {
      log(`judging ${++i}/${cases.length}: ${c.name}`)
      c.judge = await judgePair(opts.judge, c.prompt, c.a, c.b, opts.criteria)
    }
  }
  const trig = (run: string) => {
    const t = readTriggerArtifacts(run)
    return t.length ? triggerStats(t) : undefined
  }
  return {
    a: { dir: opts.aDir, run: opts.aRun, score: suiteScore(opts.aRun), trigger: trig(opts.aRun) },
    b: { dir: opts.bDir, run: opts.bRun, score: suiteScore(opts.bRun), trigger: trig(opts.bRun) },
    judgeModel: opts.judge?.model,
    cases,
    summary: summarize(cases.filter((c) => c.judge).map((c) => c.judge!.winner)),
  }
}

/** Run the suite once per version (via AGENTFOO_SKILL_OVERRIDES), then {@link compareRuns}. */
export async function compare(opts: {
  aDir: string
  bDir: string
  vitestArgs: string[]
  judge?: JudgeConfig
  criteria?: string
  outDir: string
  log?: (m: string) => void
}): Promise<CompareResult> {
  const log = opts.log ?? (() => {})
  const name = await readSkillName(opts.aDir)
  const nameB = await readSkillName(opts.bDir)
  if (name !== nameB) throw new Error(`both versions must be the same skill (got "${name}" and "${nameB}")`)
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')
  const runOnce = (label: 'A' | 'B', dir: string) =>
    new Promise<string>((done, fail) => {
      const runId = `${stamp}_cmp-${label}`
      log(`version ${label} (${dir}) → .agentfoo/runs/${runId}`)
      const child = spawn(process.execPath, [cli, 'run', ...opts.vitestArgs], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, AGENTFOO_RUN_ID: runId, AGENTFOO_SKILL_OVERRIDES: JSON.stringify({ [name]: resolve(dir) }) },
      })
      child.on('error', fail)
      child.on('exit', () => {
        const runPath = join(process.cwd(), '.agentfoo', 'runs', runId)
        existsSync(join(runPath, 'report.json')) ? done(runPath) : fail(new Error(`run ${runId} produced no report.json`))
      })
    })
  const aRun = await runOnce('A', opts.aDir)
  const bRun = await runOnce('B', opts.bDir)
  const result = await compareRuns({ ...opts, aRun, bRun })
  mkdirSync(opts.outDir, { recursive: true })
  writeFileSync(join(opts.outDir, 'compare.json'), JSON.stringify(result, null, 2))
  return result
}

export function formatCompare(r: CompareResult): string {
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${Math.round(100 * x)}%`)
  const lines = [
    `  A ${r.a.dir}\n    suite score ${r.a.score.toFixed(3)}` +
      (r.a.trigger ? ` · trigger P ${pct(r.a.trigger.precision)} R ${pct(r.a.trigger.recall)}` : ''),
    `  B ${r.b.dir}\n    suite score ${r.b.score.toFixed(3)}` +
      (r.b.trigger ? ` · trigger P ${pct(r.b.trigger.precision)} R ${pct(r.b.trigger.recall)}` : ''),
    '',
  ]
  const s = r.summary
  if (s.bWinRate !== null) {
    lines.push(
      `  judge (${r.judgeModel}, both orders): B better ${s.b} · A better ${s.a} · tie ${s.tie}`,
      `  B win rate ${pct(s.bWinRate)} (95% CI ${pct(s.ci![0])}–${pct(s.ci![1])})` +
        (s.ci![0] > 0.5 ? ' → B is better' : s.ci![1] < 0.5 ? ' → A is better' : ' → not distinguishable yet'),
    )
  } else {
    lines.push(`  ${r.cases.length} paired cases (no judge) — review them with agentfoo review --compare`)
  }
  return lines.join('\n')
}
