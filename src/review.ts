import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { sanitize, readJson, readRunForExport } from './artifacts.js'
import type { RunReport } from './artifacts.js'
import { REVIEW_PAGE } from './review-page.js'
import { SESSION_PAGE } from './session-page.js'
import { COMPARE_PAGE } from './compare-page.js'
import { planRunSpans, spanTree } from './otel.js'
import type { PlannedSpan, RunInput, SpanTree } from './otel.js'
import { buildWaterfall } from './waterfall.js'
import { summarize, type CompareResult, type Pick } from './compare.js'
import type { JudgeRecord } from './types.js'

/**
 * `agentfoo review` — human review of one run (TODO §P2.5).
 *
 * Skill self-improvement can't be left to the judge alone: the rubric can be
 * wrong (a negative criterion graded "not found → unmet"), the judge can be
 * wrong or noisy, and "is this a good article" is ultimately a human call. So a
 * person reviews each case — rates the output, agrees or disagrees with every
 * judge verdict, and edits the evaluation points themselves — and `suggest` then
 * treats that review as the highest-priority evidence.
 *
 * The page is served from 127.0.0.1 only and saves to
 * `.agentfoo/runs/<id>/review.json`. agentfoo stays suite-agnostic: criterion
 * edits are recorded as "this criterion → that text", and mapping them back into
 * a suite's own case files is the suite's job.
 */

export type Verdict = 'agree' | 'disagree'

export interface CriterionEdit {
  /** `edit` / `remove` an existing criterion, or `add` a new one. */
  action: 'edit' | 'remove' | 'add'
  /** The criterion text as graded (edit / remove). */
  criteria?: string
  /** New text (edit / add). */
  text?: string
  /** Free-form layer name the reviewer wants it in, e.g. `mustHave` / `coverage` / `mustNot`. */
  layer?: string
  /** Which grading of the test it belongs to (1-based). */
  judge?: number
}

export interface CaseReview {
  /** 1–5. */
  rating?: number
  comment?: string
  /** `"<judge index>:<criterion index>"` → verdict, both 1-based. */
  verdicts?: Record<string, Verdict>
  criteriaEdits?: CriterionEdit[]
  reviewedAt?: string
}

export interface RunReview {
  run: string
  updatedAt?: string
  cases: Record<string, CaseReview>
}

export interface ReviewCase {
  name: string
  state: 'pass' | 'fail' | 'skip'
  meta: Record<string, string>
  prompt: string
  finalMessage: string
  judges: JudgeRecord[]
}

function testDir(runPath: string, name: string): string {
  return join(runPath, ...name.split(/\s*>\s*/).map(sanitize))
}

/** Everything the review page shows about one run. */
export function loadReviewCases(runPath: string): ReviewCase[] {
  const report = readJson<RunReport>(join(runPath, 'report.json'))
  if (!report?.tests) {
    throw new Error(`${runPath}/report.json has no per-test entries — rerun with a current agentfoo.`)
  }
  return report.tests
    .filter((t) => t.state !== 'skip')
    .map((t) => {
      const dir = testDir(runPath, t.name)
      const files = existsSync(dir) ? readdirSync(dir) : []
      const turns = files.filter((f) => /^turn-\d+$/.test(f)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
      let prompt = ''
      let finalMessage = ''
      const last = turns.at(-1)
      if (last) {
        const trace = readJson<{ finalMessage?: string; messages?: Array<{ role: string; content: string }> }>(
          join(dir, last, 'trace.json'),
        )
        // Absent for a turn that produced no parseable envelope; shown as empty
        // and the reviewer can still rate and comment.
        finalMessage = trace?.finalMessage ?? ''
        prompt = trace?.messages?.find((m) => m.role === 'user')?.content ?? ''
      }
      const judges = files
        .filter((f) => /^judge-\d+\.json$/.test(f))
        .sort((a, b) => Number(a.slice(6, -5)) - Number(b.slice(6, -5)))
        .map((f) => readJson<JudgeRecord>(join(dir, f)))
        .filter((j): j is JudgeRecord => j !== undefined)
      return { name: t.name, state: t.state, meta: t.meta ?? {}, prompt, finalMessage, judges }
    })
}

export function reviewPath(runPath: string): string {
  return join(runPath, 'review.json')
}

export function loadReview(runPath: string): RunReview {
  const fallback: RunReview = { run: runPath.split(/[\\/]/).at(-1) ?? '', cases: {} }
  return readJson<RunReview>(reviewPath(runPath)) ?? fallback
}

/** Reject anything that isn't a well-formed review before it overwrites the file. */
export function validateReview(value: unknown): RunReview {
  const r = value as RunReview
  if (!r || typeof r !== 'object' || typeof r.cases !== 'object' || r.cases === null) {
    throw new Error('review must be an object with a `cases` map')
  }
  for (const [name, c] of Object.entries(r.cases)) {
    if (c.rating !== undefined && !(Number.isInteger(c.rating) && c.rating >= 1 && c.rating <= 5)) {
      throw new Error(`${name}: rating must be an integer 1–5`)
    }
    for (const v of Object.values(c.verdicts ?? {})) {
      if (v !== 'agree' && v !== 'disagree') throw new Error(`${name}: verdicts must be agree/disagree`)
    }
    for (const e of c.criteriaEdits ?? []) {
      if (!['edit', 'remove', 'add'].includes(e.action)) throw new Error(`${name}: unknown criterion action`)
    }
  }
  return r
}

export function saveReview(runPath: string, review: RunReview): void {
  const tmp = `${reviewPath(runPath)}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...review, updatedAt: new Date().toISOString() }, null, 2))
  renameSync(tmp, reviewPath(runPath)) // atomic: a crash mid-write never truncates a review
}

/** Human–judge agreement over every verdict the reviewer marked. */
export function agreement(review: RunReview): { agree: number; disagree: number; rate: number | null } {
  let agree = 0
  let disagree = 0
  for (const c of Object.values(review.cases)) {
    for (const v of Object.values(c.verdicts ?? {})) v === 'agree' ? agree++ : disagree++
  }
  return { agree, disagree, rate: agree + disagree ? agree / (agree + disagree) : null }
}

/**
 * The span subtree for one test, plus the run root so the page shows where the
 * session sits inside the run.
 *
 * Matched by test *name*, never by index: the review page lists only non-skipped
 * tests, so its indices do not line up with the plan's (which covers every test
 * `report.json` recorded).
 */
function spansForTest(tree: SpanTree, testName: string): PlannedSpan[] {
  const root = tree.root()
  const test = tree.testSpan(testName)
  if (!test) return root ? [root] : []
  return [...(root ? [root] : []), ...tree.subtree(test.key)]
}

/** Serve the review page for one run on 127.0.0.1. Resolves once listening. */
export function serveReview(runPath: string, port: number): Promise<{ server: Server; url: string }> {
  const cases = loadReviewCases(runPath)
  const runId = runPath.split(/[\\/]/).at(-1) ?? ''

  // The OTLP span plan for this run, computed once. The session page renders
  // exactly this, so the local view and what the exporter ships cannot drift.
  // Older runs (written before turn artifacts existed) simply yield no spans.
  let exportInput: RunInput | undefined
  try {
    exportInput = readRunForExport(runPath)
  } catch {
    exportInput = undefined
  }
  const plan = exportInput ? planRunSpans(exportInput) : []
  const tree = spanTree(plan)

  const server = createServer((req, res) => {
    const send = (status: number, body: string, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    const url = req.url ?? ''
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      return send(200, REVIEW_PAGE, 'text/html; charset=utf-8')
    }
    if (req.method === 'GET' && req.url === '/api/run') {
      return send(200, JSON.stringify({ runId, cases, review: loadReview(runPath) }))
    }
    // Session detail page + the OTel trace it renders.
    if (req.method === 'GET' && /^\/session\/\d+$/.test(url)) {
      return send(200, SESSION_PAGE, 'text/html; charset=utf-8')
    }
    const sessionMatch = req.method === 'GET' ? /^\/api\/session\/(\d+)$/.exec(url) : null
    if (sessionMatch) {
      const index = Number(sessionMatch[1])
      const reviewCase = cases[index]
      if (!reviewCase) return send(404, JSON.stringify({ error: `no session ${index}` }))
      const spans = spansForTest(tree, reviewCase.name)
      return send(
        200,
        JSON.stringify({
          run: { runId },
          agent: exportInput?.agent,
          case: reviewCase,
          spans,
          /** Layout for the waterfall, computed here so the page holds no math. */
          waterfall: buildWaterfall(spans),
          siblings: cases
            .map((c, i) => ({ index: i, name: c.name, state: c.state }))
            .filter((c) => c.name !== reviewCase.name),
        }),
      )
    }
    if (req.method === 'PUT' && req.url === '/api/review') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 5_000_000) req.destroy()
      })
      req.on('end', () => {
        try {
          const review = validateReview(JSON.parse(body))
          saveReview(runPath, { ...review, run: runId })
          send(200, JSON.stringify({ ok: true, agreement: agreement(review) }))
        } catch (err) {
          send(400, JSON.stringify({ ok: false, error: (err as Error).message }))
        }
      })
      return
    }
    send(404, JSON.stringify({ error: 'not found' }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const actual = typeof addr === 'object' && addr ? addr.port : port
      resolve({ server, url: `http://127.0.0.1:${actual}/` })
    })
  })
}

export interface Preferences {
  cases: Record<string, { pick?: Pick; comment?: string; votedAt?: string }>
  updatedAt?: string
}

export function loadPreferences(compareDir: string): Preferences {
  const p = join(compareDir, 'preferences.json')
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Preferences) : { cases: {} }
}

export function validatePreferences(value: unknown): Preferences {
  const v = value as Preferences
  if (!v || typeof v !== 'object' || typeof v.cases !== 'object' || v.cases === null) {
    throw new Error('preferences must be an object with a `cases` map')
  }
  for (const [name, c] of Object.entries(v.cases)) {
    if (c.pick !== undefined && !['a', 'b', 'tie'].includes(c.pick)) throw new Error(`${name}: pick must be a, b or tie`)
  }
  return v
}

/** Human preference totals, and how often the human agreed with the judge where both voted. */
export function humanSummary(result: CompareResult, prefs: Preferences) {
  const picks: Pick[] = []
  let agree = 0
  let both = 0
  for (const c of result.cases) {
    const p = prefs.cases[c.name]?.pick
    if (!p) continue
    picks.push(p)
    if (c.judge) {
      both++
      if (c.judge.winner === p) agree++
    }
  }
  return { ...summarize(picks), judgeAgreement: both ? agree / both : null }
}

/** Serve the blind side-by-side preference page for a `compare.json` directory. */
export function serveCompare(compareDir: string, port: number): Promise<{ server: Server; url: string }> {
  const result = JSON.parse(readFileSync(join(compareDir, 'compare.json'), 'utf8')) as CompareResult
  const label = compareDir.split(/[\\/]/).at(-1) ?? ''
  const server = createServer((req, res) => {
    const send = (status: number, body: string, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) return send(200, COMPARE_PAGE, 'text/html; charset=utf-8')
    if (req.method === 'GET' && req.url === '/api/compare') {
      return send(200, JSON.stringify({ label, cases: result.cases, preferences: loadPreferences(compareDir) }))
    }
    if (req.method === 'PUT' && req.url === '/api/preferences') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 2_000_000) req.destroy()
      })
      req.on('end', () => {
        try {
          const prefs = validatePreferences(JSON.parse(body))
          const tmp = join(compareDir, 'preferences.json.tmp')
          writeFileSync(tmp, JSON.stringify({ ...prefs, updatedAt: new Date().toISOString() }, null, 2))
          renameSync(tmp, join(compareDir, 'preferences.json'))
          send(200, JSON.stringify({ ok: true, human: humanSummary(result, prefs) }))
        } catch (err) {
          send(400, JSON.stringify({ ok: false, error: (err as Error).message }))
        }
      })
      return
    }
    send(404, JSON.stringify({ error: 'not found' }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}/` })
    })
  })
}
