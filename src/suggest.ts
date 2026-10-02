import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { completeJson } from './judge.js'
import { sanitize } from './artifacts.js'
import type { JudgeConfig, JudgeRecord } from './types.js'
import { loadReview, type CaseReview } from './review.js'

/**
 * `agentfoo suggest` — one backward pass of SkillOpt-style skill optimization
 * (TODO §P2.5, arXiv 2605.23904), without the loop: read a finished run's
 * evidence, have an optimizer model propose a *bounded* set of edits to SKILL.md,
 * and write them out for a human to accept. Nothing is applied to the skill.
 *
 * Mirrors the paper's backward pass where it matters for a single step:
 * failures and successes are analyzed separately in minibatches (single
 * trajectories produce anecdotal fixes; batches expose recurring ones), failure
 * edits are prioritized in the merge, successes contribute rules to *preserve*,
 * and the merged pool is clipped to an edit budget — the textual learning rate —
 * so one step can't rewrite the skill wholesale. Edits are four atomic ops on
 * exact anchors, and each records whether it applied.
 *
 * What it deliberately does not do: gate on a held-out split (that is
 * `optimize`, which needs repeated evaluation), or touch the frontmatter —
 * `description` controls triggering, which this evidence doesn't measure.
 */

export interface Evidence {
  test: string
  state: 'pass' | 'fail' | 'skip'
  meta: Record<string, string>
  finalMessage: string
  judges: Array<{
    score: number
    threshold: number
    passed: boolean
    unmet: Array<{ criteria: string; reason: string }>
    /** Verdicts a human reviewer marked wrong (see `agentfoo review`). */
    overruled: Array<{ criteria: string; judgeSaid: 'met' | 'unmet' }>
  }>
  /** The human review of this case, when `agentfoo review` was used on the run. */
  human?: Pick<CaseReview, 'rating' | 'comment' | 'criteriaEdits'>
}

/**
 * Whether the optimizer should treat a case as a failure. A human rating
 * overrides the suite's verdict both ways: an answer rated ≤ 2 is a failure even
 * if every assertion passed (the rubric missed something), and one rated ≥ 4 is
 * a success even if an assertion failed (the rubric or judge was wrong — that is
 * a rubric fix, not a skill fix).
 */
export function effectiveState(e: Evidence): 'pass' | 'fail' {
  const rating = e.human?.rating
  if (rating !== undefined && rating <= 2) return 'fail'
  if (rating !== undefined && rating >= 4) return 'pass'
  return e.state === 'fail' ? 'fail' : 'pass'
}

export type EditOp = 'append' | 'insert_after' | 'replace' | 'delete'

export interface SkillEdit {
  op: EditOp
  /** insert_after: exact text after whose line `content` goes. */
  anchor?: string
  /** replace / delete: exact text to change. */
  old?: string
  /** append / insert_after / replace: the new text. */
  content?: string
  rationale: string
  /** How many independent analyses proposed this edit (ranking signal). */
  support?: number
  source?: 'failure' | 'success'
}

export interface ApplyResult {
  edit: SkillEdit
  applied: boolean
  reason?: string
}

interface ReportTest {
  name: string
  state: 'pass' | 'fail' | 'skip'
  meta?: Record<string, string>
}

const MAX_ANSWER_CHARS = 4000

/** Most recent run under `.agentfoo/runs` that has a report.json. */
export function latestRun(root = process.cwd()): string | undefined {
  const runs = join(root, '.agentfoo', 'runs')
  if (!existsSync(runs)) return undefined
  return readdirSync(runs)
    .filter((d) => existsSync(join(runs, d, 'report.json')))
    .sort()
    .at(-1)
}

/** Everything the optimizer sees about each test of one run. */
export function loadEvidence(runPath: string): Evidence[] {
  const report = JSON.parse(readFileSync(join(runPath, 'report.json'), 'utf8')) as { tests?: ReportTest[] }
  const review = loadReview(runPath)
  if (!report.tests) {
    throw new Error(`${runPath}/report.json has no per-test entries — rerun with a current agentfoo.`)
  }
  return report.tests
    .filter((t) => t.state !== 'skip')
    .map((t) => {
      const dir = join(runPath, ...t.name.split(/\s*>\s*/).map(sanitize))
      const files = existsSync(dir) ? readdirSync(dir) : []
      const lastTurn = files
        .filter((f) => /^turn-\d+$/.test(f))
        .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
        .at(-1)
      let finalMessage = ''
      if (lastTurn) {
        try {
          finalMessage = (JSON.parse(readFileSync(join(dir, lastTurn, 'trace.json'), 'utf8')) as {
            finalMessage?: string
          }).finalMessage ?? ''
        } catch {
          // an unreadable trace just means less evidence for this test
        }
      }
      const judges = files
        .filter((f) => /^judge-\d+\.json$/.test(f))
        .sort((a, b) => Number(a.slice(6, -5)) - Number(b.slice(6, -5)))
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as JudgeRecord)
        .map((j) => {
          const verdicts = review.cases[t.name]?.verdicts ?? {}
          const wrong = (i: number) => verdicts[`${j.index}:${i + 1}`] === 'disagree'
          return {
            score: j.score,
            threshold: j.threshold,
            passed: j.passed,
            // A verdict the human overruled is not evidence about the skill.
            unmet: j.breakdown
              .map((b, i) => ({ b, i }))
              .filter(({ b, i }) => !b.met && !wrong(i))
              .map(({ b }) => ({ criteria: b.criteria, reason: b.reason })),
            overruled: j.breakdown
              .map((b, i) => ({ b, i }))
              .filter(({ i }) => wrong(i))
              .map(({ b }) => ({ criteria: b.criteria, judgeSaid: b.met ? ('met' as const) : ('unmet' as const) })),
          }
        })
      const human = review.cases[t.name]
      return {
        test: t.name,
        state: t.state,
        meta: t.meta ?? {},
        finalMessage:
          finalMessage.length > MAX_ANSWER_CHARS
            ? `${finalMessage.slice(0, MAX_ANSWER_CHARS)}\n…[truncated]`
            : finalMessage,
        judges,
        ...(human && (human.rating !== undefined || human.comment || human.criteriaEdits?.length)
          ? { human: { rating: human.rating, comment: human.comment, criteriaEdits: human.criteriaEdits } }
          : {}),
      }
    })
}

export function minibatches<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function renderEvidence(batch: Evidence[]): string {
  return batch
    .map((e, i) => {
      const grading = e.judges.length
        ? e.judges
            .map(
              (j, k) =>
                `  grading ${k + 1}: score ${j.score.toFixed(2)} (threshold ${j.threshold})` +
                j.unmet.map((u) => `\n    ✗ ${u.criteria}\n      judge: ${u.reason}`).join(''),
            )
            .join('\n')
        : e.state === 'fail'
          ? '  failed before any grading (e.g. the skill did not trigger, or the agent errored)'
          : '  no gradings'
      const human = e.human
        ? '\n  HUMAN REVIEW (highest priority — outranks the judge):' +
          (e.human.rating !== undefined ? ` rated ${e.human.rating}/5.` : '') +
          (e.human.comment ? `\n    "${e.human.comment}"` : '')
        : ''
      const overruled = e.judges
        .flatMap((j) => j.overruled)
        .map((o) => `\n  (human overruled the judge, who said ${o.judgeSaid}: ${o.criteria})`)
        .join('')
      const tags = Object.entries(e.meta)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
      return (
        `## Case ${i + 1}: ${e.test}${tags ? ` [${tags}]` : ''} — ${e.state.toUpperCase()}\n` +
        `${grading}${overruled}${human}\n\n### Agent's final answer\n${e.finalMessage || '(empty)'}`
      )
    })
    .join('\n\n')
}

const EDIT_SCHEMA =
  '{"op":"append"|"insert_after"|"replace"|"delete","anchor"?:string,"old"?:string,' +
  '"content"?:string,"rationale":string}'

const EDIT_RULES =
  'Edit ops: "append" adds `content` at the end; "insert_after" inserts `content` after the ' +
  'line containing `anchor`; "replace" swaps `old` for `content`; "delete" removes `old`. ' +
  '`anchor` and `old` must be copied EXACTLY from the skill and occur in it exactly once. ' +
  'Never touch the YAML frontmatter (between the leading --- lines). Write new text in the ' +
  "same language and style as the skill. Do not hardcode case-specific facts, topics or " +
  'answers: a rule must help on unseen tasks of the same kind. Do not duplicate what the ' +
  'skill already says; if a rule exists but is being ignored, prefer making it more ' +
  'specific or more prominent over adding a second copy.'

const FAILURE_SYSTEM =
  'You are an expert failure analyst improving an AI agent skill (a SKILL.md document the ' +
  'agent follows). You get the current skill and a minibatch of FAILED test cases: the ' +
  "judge's unmet criteria with reasons, a human reviewer's rating and comment where present " +
  "(these outrank the judge), and the agent's final answer. Identify the most " +
  'important COMMON failure patterns across the batch — not individual edge cases — and ' +
  `propose at most the given budget of skill edits that fix them. ${EDIT_RULES} Respond ` +
  'with ONLY a JSON object: {"failure_summary":[{"pattern":string,"count":number}],' +
  `"edits":[${EDIT_SCHEMA}]}`

const SUCCESS_SYSTEM =
  'You are analyzing PASSING test cases of an AI agent skill (a SKILL.md document the agent ' +
  'follows). Identify which existing instructions in the skill these successes rely on, so ' +
  'that later edits do not remove or weaken them. Quote each as an exact short excerpt of ' +
  'the skill. Respond with ONLY a JSON object: {"preserve":[string]}'

const MERGE_SYSTEM =
  'You are consolidating proposed edits to an AI agent skill (a SKILL.md document). You get ' +
  'the current skill, edits proposed by several independent failure analyses, and excerpts ' +
  'that passing cases rely on (must be preserved). Merge duplicates (count how many analyses ' +
  'proposed each as `support`), drop contradictory or case-specific edits, drop any edit that ' +
  'would delete or contradict a preserved excerpt, then rank by expected benefit on unseen ' +
  'tasks — prefer edits with higher support — and keep at most the given budget. ' +
  `${EDIT_RULES} Respond with ONLY a JSON object: {"edits":[${EDIT_SCHEMA.slice(0, -1)},` +
  '"support":number}]}'

/** Delimiters of the region only `optimize`'s epoch-wise slow update may write. */
export const SLOW_START = '<!-- SLOW_UPDATE_START -->'
export const SLOW_END = '<!-- SLOW_UPDATE_END -->'

/** [start, end) of the protected slow-update block, if the skill has one. */
function protectedRange(skill: string): [number, number] | undefined {
  const s = skill.indexOf(SLOW_START)
  const e = skill.indexOf(SLOW_END)
  return s !== -1 && e > s ? [s, e + SLOW_END.length] : undefined
}

/** Where the YAML frontmatter ends (0 when there is none). */
function frontmatterEnd(skill: string): number {
  const m = skill.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? m[0].length : 0
}

function occurrences(haystack: string, needle: string): number[] {
  const at: number[] = []
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) at.push(i)
  return at
}

/**
 * Apply edits in order, each against the result of the previous one. An edit
 * whose anchor is missing, ambiguous, or inside the frontmatter is skipped and
 * reported — never guessed at — so every change in the output has a recorded,
 * exact origin (SkillOpt's `edit_apply_report.json`).
 */
export function applyEdits(skill: string, edits: SkillEdit[]): { skill: string; results: ApplyResult[] } {
  let out = skill
  const results: ApplyResult[] = []
  for (const edit of edits) {
    const skip = (reason: string) => results.push({ edit, applied: false, reason })
    const fm = frontmatterEnd(out)
    if (edit.op === 'append') {
      if (!edit.content?.trim()) {
        skip('append without content')
        continue
      }
      out = `${out.replace(/\s*$/, '')}\n\n${edit.content.trim()}\n`
      results.push({ edit, applied: true })
      continue
    }
    const needle = edit.op === 'insert_after' ? edit.anchor : edit.old
    if (!needle) {
      skip(`${edit.op} without ${edit.op === 'insert_after' ? 'anchor' : 'old'}`)
      continue
    }
    const at = occurrences(out, needle)
    if (at.length === 0) {
      skip('anchor text not found in the skill')
      continue
    }
    if (at.length > 1) {
      skip(`anchor text is ambiguous (${at.length} matches)`)
      continue
    }
    if (at[0] < fm) {
      skip('edits to the frontmatter are out of scope')
      continue
    }
    const start = at[0]
    const end = start + needle.length
    const guard = protectedRange(out)
    if (guard && start < guard[1] && end > guard[0]) {
      skip('the slow-update region is written only by the epoch-wise slow update')
      continue
    }
    if (edit.op === 'insert_after') {
      if (!edit.content?.trim()) {
        skip('insert_after without content')
        continue
      }
      const eol = out.indexOf('\n', end)
      const cut = eol === -1 ? out.length : eol
      out = `${out.slice(0, cut)}\n${edit.content.replace(/\n+$/, '')}${out.slice(cut)}`
    } else if (edit.op === 'replace') {
      if (edit.content === undefined) {
        skip('replace without content')
        continue
      }
      out = `${out.slice(0, start)}${edit.content}${out.slice(end)}`
    } else if (edit.op === 'delete') {
      out = `${out.slice(0, start)}${out.slice(end)}`
    } else {
      skip(`unknown op "${String((edit as SkillEdit).op)}"`)
      continue
    }
    results.push({ edit, applied: true })
  }
  return { skill: out, results }
}

export interface SuggestOptions {
  skillDir: string
  runPath: string
  optimizer: JudgeConfig
  /** Max edits in the final suggestion (textual learning rate). Default 4. */
  budget?: number
  /** Evidence cases per reflection call. Default 8. */
  batchSize?: number
  outDir: string
  /**
   * Edits tried earlier and rejected by a validation gate, with the score change
   * they caused (SkillOpt's rejected-edit buffer): shown to the optimizer so it
   * doesn't propose them again. Set by `agentfoo optimize`.
   */
  rejected?: Array<{ edits: SkillEdit[]; delta: number }>
  /**
   * Optimizer-side memory from earlier epochs (which kinds of edit helped, which
   * were rejected, which failures persist). Shown to the optimizer, never shipped
   * in the skill. Set by `agentfoo optimize`.
   */
  meta?: string
  log?: (msg: string) => void
}

export interface SuggestResult {
  outDir: string
  failures: number
  successes: number
  edits: SkillEdit[]
  results: ApplyResult[]
}

export async function suggest(opts: SuggestOptions): Promise<SuggestResult> {
  const log = opts.log ?? (() => {})
  const budget = opts.budget ?? 4
  const batchSize = opts.batchSize ?? 8
  const skillPath = join(opts.skillDir, 'SKILL.md')
  const skill = readFileSync(skillPath, 'utf8')
  const evidence = loadEvidence(opts.runPath)
  const failures = evidence.filter((e) => effectiveState(e) === 'fail')
  const successes = evidence.filter((e) => effectiveState(e) === 'pass')
  log(`evidence: ${failures.length} failed, ${successes.length} passed`)
  if (!failures.length) {
    throw new Error('No failed tests in this run — nothing to learn from. Tighten the rubric or add cases.')
  }

  const rejectedBlock = opts.rejected?.length
    ? '\n\n# Previously rejected edits — they lowered the validation score; do not propose them again\n\n' +
      opts.rejected
        .map((r) => `- score change ${r.delta.toFixed(3)}:\n${JSON.stringify(r.edits, null, 2)}`)
        .join('\n')
    : ''
  const metaBlock = opts.meta?.trim()
    ? `# Optimizer notes from earlier epochs (for you, not part of the skill)\n\n${opts.meta.trim()}\n\n`
    : ''
  const skillBlock =
    `${metaBlock}# Current skill (SKILL.md)\n\n${skill}${rejectedBlock}` +
    (skill.includes(SLOW_START) ? `\n\nThe block between ${SLOW_START} and ${SLOW_END} is read-only for you.` : '')

  const failureBatches = minibatches(failures, batchSize)
  const proposals: Array<{ failure_summary?: Array<{ pattern: string; count: number }>; edits?: SkillEdit[] }> = []
  for (const [i, batch] of failureBatches.entries()) {
    log(`analyzing failures ${i + 1}/${failureBatches.length} (${batch.length} cases)`)
    proposals.push(
      await completeJson(
        opts.optimizer,
        FAILURE_SYSTEM,
        `${skillBlock}\n\n# Edit budget\n${budget}\n\n# Failed cases\n\n${renderEvidence(batch)}`,
      ),
    )
  }

  const preserve: string[] = []
  const successBatches = minibatches(successes, batchSize)
  for (const [i, batch] of successBatches.entries()) {
    log(`analyzing successes ${i + 1}/${successBatches.length} (${batch.length} cases)`)
    const r = await completeJson<{ preserve?: string[] }>(
      opts.optimizer,
      SUCCESS_SYSTEM,
      `${skillBlock}\n\n# Passing cases\n\n${renderEvidence(batch)}`,
    )
    preserve.push(...(r.preserve ?? []))
  }

  const proposed = proposals.flatMap((p) => (p.edits ?? []).map((e) => ({ ...e, source: 'failure' as const })))
  log(`merging ${proposed.length} proposed edits under budget ${budget}`)
  const merged = await completeJson<{ edits?: SkillEdit[] }>(
    opts.optimizer,
    MERGE_SYSTEM,
    `${skillBlock}\n\n# Edit budget\n${budget}\n\n` +
      `# Proposed edits (JSON)\n${JSON.stringify(proposed, null, 2)}\n\n` +
      `# Excerpts passing cases rely on (preserve)\n${preserve.map((p) => `- ${p}`).join('\n') || '(none)'}`,
  )
  // The model is asked to respect the budget; the clip makes it a guarantee.
  const edits = (merged.edits ?? []).slice(0, budget)

  const { skill: suggested, results } = applyEdits(skill, edits)

  mkdirSync(opts.outDir, { recursive: true })
  const suggestedPath = join(opts.outDir, 'SKILL.suggested.md')
  writeFileSync(suggestedPath, suggested)
  const diff = spawnSync('diff', ['-u', '--label', 'SKILL.md', '--label', 'SKILL.suggested.md', skillPath, suggestedPath], {
    encoding: 'utf8',
  }).stdout
  writeFileSync(join(opts.outDir, 'SKILL.md.diff'), diff ?? '')
  writeFileSync(
    join(opts.outDir, 'suggestions.json'),
    JSON.stringify(
      {
        skill: relative(process.cwd(), skillPath),
        run: relative(process.cwd(), opts.runPath),
        optimizer: opts.optimizer.model,
        budget,
        batchSize,
        failures: failures.map((f) => f.test),
        successes: successes.map((s) => s.test),
        failureSummaries: proposals.map((p) => p.failure_summary ?? []),
        proposed,
        preserve,
        edits: results,
      },
      null,
      2,
    ),
  )
  writeFileSync(join(opts.outDir, 'suggestions.md'), renderMarkdown(proposals, preserve, results, diff ?? ''))

  return { outDir: opts.outDir, failures: failures.length, successes: successes.length, edits, results }
}

function renderMarkdown(
  proposals: Array<{ failure_summary?: Array<{ pattern: string; count: number }> }>,
  preserve: string[],
  results: ApplyResult[],
  diff: string,
): string {
  const patterns = proposals.flatMap((p) => p.failure_summary ?? [])
  const lines = ['# Suggested skill edits', '']
  lines.push('## Failure patterns', '')
  for (const p of patterns) lines.push(`- (${p.count}) ${p.pattern}`)
  lines.push('', '## Edits', '')
  results.forEach((r, i) => {
    const { edit } = r
    lines.push(
      `### ${i + 1}. ${edit.op}${edit.support ? ` · support ${edit.support}` : ''} — ${r.applied ? 'applied' : `SKIPPED: ${r.reason}`}`,
      '',
      edit.rationale,
      '',
    )
    if (edit.anchor) lines.push('after:', '```', edit.anchor, '```')
    if (edit.old) lines.push('old:', '```', edit.old, '```')
    if (edit.content) lines.push('new:', '```', edit.content, '```')
    lines.push('')
  })
  if (preserve.length) {
    lines.push('## Relied on by passing cases (kept)', '')
    for (const p of preserve) lines.push(`- ${p}`)
    lines.push('')
  }
  lines.push('## Diff', '', '```diff', diff.trim() || '(no applicable edits)', '```', '')
  lines.push(
    'Nothing was changed in the skill. Review, apply what you agree with, and re-run the ' +
      'eval — a suggestion that reads well can still make the agent worse.',
  )
  return lines.join('\n')
}
