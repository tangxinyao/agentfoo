import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSkillName } from './agent/shared.js'
import { SLOW_END, SLOW_START, loadEvidence, suggest, type ApplyResult, type SkillEdit } from './suggest.js'
import { compareRuns, type PreferenceSummary } from './compare.js'
import { completeJson } from './judge.js'
import type { JudgeConfig } from './types.js'

/**
 * `agentfoo optimize` — SkillOpt's training loop (arXiv 2605.23904, TODO §P2.5)
 * on top of the pieces agentfoo already has: `agentfoo run` is the forward pass,
 * {@link suggest} the backward pass, and a held-out split the gate.
 *
 * Each step: run the train split with the current skill, turn its evidence into
 * at most L_t edits (cosine-decayed budget, the textual learning rate), run the
 * selection split with that candidate, and accept it only if the selection score
 * beats the current one by more than `margin`. A rejected candidate's edits and
 * score drop go into a buffer the next backward pass sees. Identical candidates
 * are scored once (hash cache).
 *
 * Not implemented from the paper: the epoch-wise slow update into a protected
 * region, and the optimizer-side meta skill. The deployed output is
 * `best/SKILL.md` plus a diff — the skill being optimized is never written to.
 */

export interface OptimizeOptions {
  skillDir: string
  /** vitest `-t` pattern selecting the train split, e.g. `\[train/`. */
  trainFilter: string
  /** vitest `-t` pattern selecting the selection (validation) split, e.g. `\[sel/`. */
  selFilter: string
  optimizer: JudgeConfig
  outDir: string
  /** Default 2. */
  epochs?: number
  /** Optimization steps per epoch. Default 2. */
  stepsPerEpoch?: number
  /** Edit budget at the first step (cosine-decays to `minBudget`). Default 4. */
  budget?: number
  /** Default 2. */
  minBudget?: number
  /**
   * Required improvement over the current selection score. Default 0 (strictly
   * greater, the paper's gate). With an LLM judge, set it to about the score's
   * run-to-run noise so the gate doesn't accept luck.
   */
  margin?: number | 'auto'
  /**
   * How many times to run the selection split with the original skill. With
   * more than one, the baseline is their mean and `margin: 'auto'` becomes their
   * standard deviation — the gate then requires an improvement larger than the
   * run-to-run noise it just measured. Default 1, or 2 when margin is 'auto'.
   */
  baselineRuns?: number
  /**
   * `score` (default): accept when the selection objective improves by > margin.
   * `pairwise`: accept when the candidate's selection answers beat the current
   * skill's in a both-orders pairwise judgement — sharper than absolute scores
   * for "is this better", at the cost of one pairwise call per case.
   */
  gate?: 'score' | 'pairwise'
  /** Epoch-wise slow update into the protected SKILL.md region (from epoch 2). Default on. */
  slowUpdate?: boolean
  /** Optimizer-side notes carried across epochs (never shipped). Default on. */
  metaMemory?: boolean
  /** Extra args for every `agentfoo run` (e.g. `-a pi`, `--env-file ../.env`). */
  runArgs?: string[]
  /** Evaluate one split; returns the run directory. Injected in tests. */
  runner?: (filter: string, overrides: Record<string, string>, runId: string) => Promise<string>
  log?: (msg: string) => void
}

export interface StepRecord {
  epoch: number
  step: number
  budget: number
  trainRun: string
  selRun?: string
  score?: number
  cached?: boolean
  accepted: boolean
  reason?: string
  edits: ApplyResult[]
  /** Pairwise gate outcome, when `gate: 'pairwise'`. */
  pairwise?: PreferenceSummary
  /** The guidance a slow-update step wrote (step 0 of its epoch). */
  slowUpdate?: string
}

export interface OptimizeResult {
  baseline: number
  /** The margin the gate actually used (resolved when 'auto'). */
  margin?: number
  best: number
  bestDir: string
  steps: StepRecord[]
  /** Final optimizer-side notes (also in meta.md). */
  meta?: string
}

/** One scalar per run: mean over tests of their mean judge score (a judgeless test counts 1 if it passed, else 0). */
export function runObjective(runPath: string): number {
  const report = JSON.parse(readFileSync(join(runPath, 'report.json'), 'utf8')) as {
    tests?: Array<{ state: string; judges: Array<{ score: number }> }>
  }
  const tests = (report.tests ?? []).filter((t) => t.state !== 'skip')
  if (!tests.length) throw new Error(`${runPath}: no tests ran — check the split filter`)
  const r = tests.map((t) =>
    t.judges.length ? t.judges.reduce((s, j) => s + j.score, 0) / t.judges.length : t.state === 'pass' ? 1 : 0,
  )
  return r.reduce((s, x) => s + x, 0) / r.length
}

/** Cosine decay from `max` at step 0 to `min` at the last step, rounded to whole edits. */
export function cosineBudget(step: number, total: number, max: number, min: number): number {
  if (total <= 1) return max
  return Math.round(min + ((max - min) * (1 + Math.cos((Math.PI * step) / (total - 1)))) / 2)
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

export async function optimize(opts: OptimizeOptions): Promise<OptimizeResult> {
  const log = opts.log ?? (() => {})
  const epochs = opts.epochs ?? 2
  const perEpoch = opts.stepsPerEpoch ?? 2
  const total = epochs * perEpoch
  const pairwise = opts.gate === 'pairwise'
  const auto = opts.margin === 'auto'
  const baselineRuns = opts.baselineRuns ?? (auto && !pairwise ? 2 : 1)
  if (auto && !pairwise && baselineRuns < 2) throw new Error("margin 'auto' needs baselineRuns >= 2 to measure noise")
  const name = await readSkillName(opts.skillDir)
  const runner = opts.runner ?? defaultRunner(opts.runArgs ?? [], log)
  mkdirSync(opts.outDir, { recursive: true })

  let seq = 0
  const runId = (label: string) => `${new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')}_opt-${++seq}-${label}`
  const evaluate = (filter: string, dir: string, label: string) =>
    runner(filter, dir === opts.skillDir ? {} : { [name]: dir }, runId(label))

  const cache = new Map<string, number>()
  let currentDir = opts.skillDir
  log(`baseline: selection split with the original skill ×${baselineRuns}`)
  const baselineScores: number[] = []
  let currentSelRun = ''
  for (let i = 1; i <= baselineRuns; i++) {
    currentSelRun = await evaluate(opts.selFilter, currentDir, `sel-baseline-${i}`)
    baselineScores.push(runObjective(currentSelRun))
  }
  const bMean = baselineScores.reduce((s, x) => s + x, 0) / baselineScores.length
  const bStdev = Math.sqrt(baselineScores.reduce((s, x) => s + (x - bMean) ** 2, 0) / baselineScores.length)
  const margin = auto ? (pairwise ? 0 : bStdev) : ((opts.margin as number | undefined) ?? 0)
  let current = bMean
  cache.set(hash(readFileSync(join(currentDir, 'SKILL.md'), 'utf8')), current)
  const baseline = current
  let best = current
  let bestDir = currentDir
  log(
    `baseline selection score ${current.toFixed(3)}` +
      (baselineRuns > 1 ? ` (±${bStdev.toFixed(3)} over ${baselineRuns} runs)` : '') +
      (pairwise ? ` · gate: pairwise vs current${auto ? ' (95% CI above 50%)' : ` (win rate > ${(0.5 + margin).toFixed(2)})`}` : ` · acceptance margin ${margin.toFixed(3)}`),
  )

  const rejected: Array<{ edits: SkillEdit[]; delta: number }> = []
  const steps: StepRecord[] = []
  let meta = ''

  /**
   * The one validation gate for every candidate — step edits and slow updates
   * alike. Score gate: selection objective beats the current one by > margin.
   * Pairwise gate: the candidate's selection answers beat the current skill's
   * case by case (judged both orders), by win rate or, with margin 'auto', by a
   * 95% interval entirely above one half.
   */
  const gate = async (candidateDir: string, label: string) => {
    const text = readFileSync(join(candidateDir, 'SKILL.md'), 'utf8')
    const key = hash(text)
    if (!pairwise && cache.has(key)) {
      const score = cache.get(key)!
      return { score, cached: true, accepted: score > current + margin, selRun: undefined as string | undefined, pairwise: undefined }
    }
    log(`selection split with ${label}`)
    const selRun = await evaluate(opts.selFilter, candidateDir, `sel-${label}`)
    const score = runObjective(selRun)
    cache.set(key, score)
    if (!pairwise) return { score, cached: false, accepted: score > current + margin, selRun, pairwise: undefined }
    const cmp = await compareRuns({ aDir: currentDir, bDir: candidateDir, aRun: currentSelRun, bRun: selRun, judge: opts.optimizer })
    const s = cmp.summary
    const accepted = s.bWinRate !== null && (auto ? s.ci![0] > 0.5 : s.bWinRate > 0.5 + margin)
    return { score, cached: false, accepted, selRun, pairwise: s }
  }

  const accept = (dir: string, score: number, selRun: string | undefined) => {
    currentDir = dir
    current = score
    if (selRun) currentSelRun = selRun
    if (score > best || pairwise) {
      best = score
      bestDir = dir
    }
  }

  let prevEpochTrain: string | undefined
  for (let epoch = 1; epoch <= epochs; epoch++) {
    rejected.length = 0 // the buffer is epoch-local, as in the paper
    let lastTrain = ''
    for (let step = 1; step <= perEpoch; step++) {
      const k = (epoch - 1) * perEpoch + step
      const budget = cosineBudget(k - 1, total, opts.budget ?? 4, opts.minBudget ?? 2)
      const stepDir = join(opts.outDir, `step-${k}`)
      log(`epoch ${epoch} step ${step}: train split, budget ${budget}`)
      const trainRun = await evaluate(opts.trainFilter, currentDir, `train-${k}`)
      lastTrain = trainRun

      let proposal
      try {
        proposal = await suggest({
          skillDir: currentDir,
          runPath: trainRun,
          optimizer: opts.optimizer,
          budget,
          outDir: join(stepDir, 'suggest'),
          rejected: [...rejected],
          meta,
          log,
        })
      } catch (err) {
        steps.push({ epoch, step, budget, trainRun, accepted: false, reason: (err as Error).message, edits: [] })
        log(`no proposal: ${(err as Error).message}`)
        if (/No failed tests/.test((err as Error).message)) break
        continue
      }

      const candidateDir = join(stepDir, 'skill')
      cpSync(currentDir, candidateDir, { recursive: true })
      writeFileSync(join(candidateDir, 'SKILL.md'), readFileSync(join(proposal.outDir, 'SKILL.suggested.md'), 'utf8'))
      const applied = proposal.results.filter((r) => r.applied)
      if (!applied.length) {
        steps.push({ epoch, step, budget, trainRun, accepted: false, reason: 'no edit applied', edits: proposal.results })
        continue
      }

      const g = await gate(candidateDir, `candidate ${k} (${applied.length} edits)`)
      log(`candidate ${k}: ${describeGate(g, current)} → ${g.accepted ? 'ACCEPT' : 'reject'}`)
      steps.push({
        epoch, step, budget, trainRun, selRun: g.selRun, score: g.score, cached: g.cached,
        accepted: g.accepted, edits: proposal.results, pairwise: g.pairwise,
      })
      if (g.accepted) accept(candidateDir, g.score, g.selRun)
      else rejected.push({ edits: applied.map((r) => r.edit), delta: g.score - current })
      writeHistory(opts.outDir, { baseline, margin, best, bestDir, steps, meta })
    }

    // Epoch-wise slow update and optimizer memory (from the second epoch on).
    if (epoch >= 2 && opts.slowUpdate !== false && prevEpochTrain) {
      log(`epoch ${epoch}: slow update — train split with the epoch-end skill vs the previous epoch's`)
      const endTrain = await evaluate(opts.trainFilter, currentDir, `train-epoch-${epoch}`)
      const groups = classifyEpochs(prevEpochTrain, endTrain)
      const guidance = await completeJson<{ guidance?: string }>(
        opts.optimizer,
        SLOW_SYSTEM,
        `# Current skill (SKILL.md)\n\n${readFileSync(join(currentDir, 'SKILL.md'), 'utf8')}\n\n${renderGroups(groups)}`,
      )
      if (guidance.guidance?.trim()) {
        const dir = join(opts.outDir, `slow-${epoch}`, 'skill')
        cpSync(currentDir, dir, { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'), withSlowBlock(readFileSync(join(currentDir, 'SKILL.md'), 'utf8'), guidance.guidance.trim()))
        const g = await gate(dir, `slow update ${epoch}`)
        log(`slow update ${epoch}: ${describeGate(g, current)} → ${g.accepted ? 'ACCEPT' : 'reject'}`)
        steps.push({
          epoch, step: 0, budget: 0, trainRun: endTrain, selRun: g.selRun, score: g.score, cached: g.cached,
          accepted: g.accepted, reason: 'slow update', edits: [], pairwise: g.pairwise, slowUpdate: guidance.guidance.trim(),
        })
        if (g.accepted) accept(dir, g.score, g.selRun)
      }
      lastTrain = endTrain
    }
    if (epoch >= 2 && opts.metaMemory !== false) {
      const r = await completeJson<{ notes?: string }>(
        opts.optimizer,
        META_SYSTEM,
        `# Previous notes\n\n${meta || '(none)'}\n\n# Optimization history so far (JSON)\n\n` +
          JSON.stringify(steps.map((s) => ({
            epoch: s.epoch, step: s.step, accepted: s.accepted, score: s.score, reason: s.reason,
            edits: s.edits.filter((e) => e.applied).map((e) => ({ op: e.edit.op, rationale: e.edit.rationale })),
          })), null, 1),
      )
      if (r.notes?.trim()) {
        meta = r.notes.trim()
        writeFileSync(join(opts.outDir, 'meta.md'), `${meta}\n`)
        log(`epoch ${epoch}: optimizer notes updated (${meta.length} chars)`)
      }
    }
    prevEpochTrain = lastTrain
    writeHistory(opts.outDir, { baseline, margin, best, bestDir, steps, meta })
  }

  const out = join(opts.outDir, 'best')
  cpSync(bestDir, out, { recursive: true })
  writeHistory(opts.outDir, { baseline, margin, best, bestDir: out, steps, meta })
  return { baseline, margin, best, bestDir: out, steps, meta }
}

function describeGate(
  g: { score: number; cached: boolean; pairwise?: { a: number; b: number; tie: number; bWinRate: number | null } },
  current: number,
): string {
  const base = `${g.score.toFixed(3)} vs current ${current.toFixed(3)}${g.cached ? ' (cached)' : ''}`
  if (!g.pairwise) return base
  const p = g.pairwise
  return `${base}; pairwise candidate ${p.b} / current ${p.a} / tie ${p.tie}, win rate ${p.bWinRate === null ? '–' : p.bWinRate.toFixed(2)}`
}

const SLOW_SYSTEM =
  'You maintain the long-horizon guidance section of an AI agent skill (a SKILL.md document). ' +
  "You get the current skill and the same training cases run under the previous epoch's skill " +
  'and the current one, grouped into improvements, regressions, persistent failures and stable ' +
  'successes. Write a short guidance block (at most ~12 bullet lines) of durable lessons: what the ' +
  'regressions and persistent failures have in common, and which behaviours the improvements and ' +
  'stable successes show must be kept. General rules only — no case-specific topics or answers. ' +
  'Write in the same language as the skill. Respond with ONLY a JSON object: {"guidance": string}'

const META_SYSTEM =
  'You keep private notes for an optimizer that edits an AI agent skill over several epochs. ' +
  'From the history of accepted and rejected edits (with scores) and your previous notes, write ' +
  'updated notes (at most ~10 bullet lines): which kinds of edits helped, which kinds were ' +
  'rejected or hurt, and which failure patterns persist. These notes guide future edit ' +
  'proposals and are never shown to the agent. Respond with ONLY a JSON object: {"notes": string}'

/** Insert or replace the protected slow-update block at the end of the skill. */
export function withSlowBlock(skill: string, guidance: string): string {
  const block = `${SLOW_START}\n## Lessons from optimization\n\n${guidance}\n${SLOW_END}`
  const s = skill.indexOf(SLOW_START)
  const e = skill.indexOf(SLOW_END)
  if (s !== -1 && e > s) return `${skill.slice(0, s)}${block}${skill.slice(e + SLOW_END.length)}`
  return `${skill.replace(/\s*$/, '')}\n\n${block}\n`
}

interface EpochCase {
  name: string
  prev: number
  cur: number
  answer: string
  unmet: string[]
}

/** Pair the same training tests across two epoch-end runs and bucket them (SkillOpt §3.6). */
export function classifyEpochs(prevRun: string, curRun: string): Record<'improved' | 'regressed' | 'persistentFailure' | 'stableSuccess', EpochCase[]> {
  const prev = new Map(loadEvidence(prevRun).map((e) => [e.test, e]))
  const groups = { improved: [] as EpochCase[], regressed: [] as EpochCase[], persistentFailure: [] as EpochCase[], stableSuccess: [] as EpochCase[] }
  const sc = (e: ReturnType<typeof loadEvidence>[number]) =>
    e.judges.length ? e.judges.reduce((s, j) => s + j.score, 0) / e.judges.length : e.state === 'pass' ? 1 : 0
  for (const e of loadEvidence(curRun)) {
    const p = prev.get(e.test)
    if (!p) continue
    const c: EpochCase = {
      name: e.test,
      prev: sc(p),
      cur: sc(e),
      answer: e.finalMessage.slice(0, 1500),
      unmet: e.judges.flatMap((j) => j.unmet.map((u) => u.criteria)),
    }
    const wasPass = p.state === 'pass'
    const isPass = e.state === 'pass'
    if (!wasPass && isPass) groups.improved.push(c)
    else if (wasPass && !isPass) groups.regressed.push(c)
    else if (!isPass) (c.cur > c.prev + 0.1 ? groups.improved : c.cur < c.prev - 0.1 ? groups.regressed : groups.persistentFailure).push(c)
    else groups.stableSuccess.push(c)
  }
  return groups
}

function renderGroups(groups: ReturnType<typeof classifyEpochs>): string {
  const section = (title: string, cases: EpochCase[], detail: boolean) =>
    `## ${title} (${cases.length})\n\n` +
    (cases.length
      ? cases
          .map((c) =>
            `- ${c.name}: ${c.prev.toFixed(2)} → ${c.cur.toFixed(2)}` +
            (detail && c.unmet.length ? `\n  unmet: ${c.unmet.join(' | ')}` : '') +
            (detail ? `\n  answer (excerpt): ${c.answer.replace(/\s+/g, ' ').slice(0, 600)}` : ''),
          )
          .join('\n')
      : '(none)')
  return [
    section('Regressions', groups.regressed, true),
    section('Persistent failures', groups.persistentFailure, true),
    section('Improvements', groups.improved, false),
    section('Stable successes', groups.stableSuccess, false),
  ].join('\n\n')
}

function writeHistory(outDir: string, result: OptimizeResult): void {
  writeFileSync(join(outDir, 'history.json'), JSON.stringify(result, null, 2))
}

/** Evaluate a split by spawning `agentfoo run -t <filter>` with the candidate override. */
function defaultRunner(runArgs: string[], log: (m: string) => void): NonNullable<OptimizeOptions['runner']> {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
  return (filter, overrides, runId) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'run', ...runArgs, '-t', filter], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: {
          ...process.env,
          AGENTFOO_RUN_ID: runId,
          AGENTFOO_SKILL_OVERRIDES: JSON.stringify(overrides),
        },
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        const runPath = join(process.cwd(), '.agentfoo', 'runs', runId)
        // A nonzero exit just means some tests failed — that is the signal we want.
        if (existsSync(join(runPath, 'report.json'))) resolve(runPath)
        else reject(new Error(`agentfoo run ${runId} exited ${code} without a report.json`))
      })
      log(`  agentfoo run -t ${filter} → .agentfoo/runs/${runId}`)
    })
}
