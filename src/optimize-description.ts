import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSkillName } from './agent/shared.js'
import { readTriggerArtifacts, triggerStats } from './artifacts.js'
import { loadAnswers } from './compare.js'
import { completeJson } from './judge.js'
import type { JudgeConfig } from './types.js'

/**
 * `agentfoo optimize-description` — the trigger half of skill optimization
 * (TODO §P2.5). SkillOpt optimizes the body with the skill already in context;
 * whether an agent *reaches for* the skill at all is decided by the frontmatter
 * `description`, which only autonomous runs measure.
 *
 * Signal: the trigger records every `toHaveBeenCalled` / `.not` assertion writes,
 * reduced to precision / recall / F1 per split. Runs set
 * `AGENTFOO_TRIGGER_ONLY=1`, which turns `toSatisfy` into a no-op, so evaluating a
 * description costs agent turns but no judge calls.
 *
 * Each step: collect the train split's misses (should fire but didn't, fired but
 * shouldn't), have the optimizer write a few candidate descriptions, score each
 * on the selection split, and accept the best only if its F1 beats the current
 * one by more than `margin`. Only the `description` field changes.
 */

export interface DescriptionCandidate {
  description: string
  rationale?: string
  f1?: number
  precision?: number | null
  recall?: number | null
  selRun?: string
}

export interface DescriptionStep {
  step: number
  trainRun: string
  misses: { falseNegatives: string[]; falsePositives: string[] }
  candidates: DescriptionCandidate[]
  accepted?: string
}

export interface DescriptionResult {
  baseline: { description: string; f1: number; precision: number | null; recall: number | null }
  best: { description: string; f1: number }
  steps: DescriptionStep[]
  bestDir: string
}

/** Read the frontmatter `description` (plain, quoted, or block scalar). */
export function readDescription(skill: string): string {
  const fm = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return ''
  const lines = fm[1].split(/\r?\n/)
  const i = lines.findIndex((l) => /^description:/.test(l))
  if (i === -1) return ''
  const first = lines[i].replace(/^description:\s*/, '')
  if (/^[|>][-+]?\s*$/.test(first)) {
    const body: string[] = []
    for (let j = i + 1; j < lines.length && /^\s+/.test(lines[j]); j++) body.push(lines[j].trim())
    return body.join(first.startsWith('>') ? ' ' : '\n')
  }
  if (first.startsWith('"')) {
    try {
      return JSON.parse(first) as string
    } catch {
      return first.slice(1, -1)
    }
  }
  if (first.startsWith("'")) return first.slice(1, -1).replace(/''/g, "'")
  return first
}

/**
 * Replace the frontmatter `description` with `text`, written as a double-quoted
 * YAML scalar (JSON string syntax is valid YAML) so colons, quotes and `#` in
 * the new text can't break the frontmatter. Everything else is left as is.
 */
export function withDescription(skill: string, text: string): string {
  const fm = skill.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  if (!fm) throw new Error('skill has no YAML frontmatter')
  const lines = fm[2].split(/\r?\n/)
  const i = lines.findIndex((l) => /^description:/.test(l))
  const line = `description: ${JSON.stringify(text)}`
  if (i === -1) {
    lines.push(line)
  } else {
    let j = i + 1
    while (j < lines.length && /^\s+/.test(lines[j])) j++ // drop a block scalar's body
    lines.splice(i, j - i, line)
  }
  return `${fm[1]}${lines.join('\n')}${fm[3]}${skill.slice(fm[0].length)}`
}

/** Trigger F1 for one skill in one run (0 when undefined). */
export function runTriggerScore(runPath: string, skill: string) {
  const s = triggerStats(readTriggerArtifacts(runPath).filter((r) => r.skill === skill))
  return { ...s, score: s.f1 ?? 0 }
}

const PROPOSE_SYSTEM =
  "You improve the `description` of an AI agent skill. An agent sees only each skill's name " +
  'and description when deciding whether to load it, so the description must say what the ' +
  'skill does AND when to use it, precisely enough that it is picked for requests it fits ' +
  'and ignored otherwise. You get the current skill, requests where it should have triggered ' +
  "but didn't, requests where it triggered but shouldn't have, some correct decisions, and " +
  'earlier rejected attempts with their scores. Propose the requested number of alternative ' +
  'descriptions that fix the misses without breaking the correct decisions. Generalize: ' +
  'describe kinds of requests and their signals, never copy the listed requests. At most 1024 ' +
  'characters each, same language as the current one. Respond with ONLY a JSON object: ' +
  '{"candidates":[{"description":string,"rationale":string}]}'

export async function optimizeDescription(opts: {
  skillDir: string
  trainFilter: string
  selFilter: string
  optimizer: JudgeConfig
  outDir: string
  steps?: number
  candidates?: number
  margin?: number
  /** Evaluate one split in trigger-only mode; returns the run dir. Injected in tests. */
  runner?: (filter: string, overrides: Record<string, string>, runId: string) => Promise<string>
  log?: (m: string) => void
}): Promise<DescriptionResult> {
  const log = opts.log ?? (() => {})
  const name = await readSkillName(opts.skillDir)
  const runner = opts.runner ?? triggerRunner()
  const margin = opts.margin ?? 0
  mkdirSync(opts.outDir, { recursive: true })
  let seq = 0
  const runId = (label: string) => `${new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')}_desc-${++seq}-${label}`
  const evaluate = (filter: string, dir: string, label: string) =>
    runner(filter, dir === opts.skillDir ? {} : { [name]: dir }, runId(label))

  let currentDir = opts.skillDir
  let currentDesc = readDescription(readFileSync(join(currentDir, 'SKILL.md'), 'utf8'))
  log('baseline: selection split, trigger-only')
  const base = runTriggerScore(await evaluate(opts.selFilter, currentDir, 'sel-baseline'), name)
  let current = base.score
  log(`baseline trigger F1 ${current.toFixed(3)} (P ${fmt(base.precision)} R ${fmt(base.recall)})`)

  const steps: DescriptionStep[] = []
  const tried: Array<{ description: string; f1: number }> = []
  for (let step = 1; step <= (opts.steps ?? 3); step++) {
    log(`step ${step}: train split with the current description`)
    const trainRun = await evaluate(opts.trainFilter, currentDir, `train-${step}`)
    const records = readTriggerArtifacts(trainRun).filter((r) => r.skill === name)
    const prompts = loadAnswers(trainRun)
    const promptOf = (test: string) => prompts.get(test)?.prompt ?? test
    const fn = records.filter((r) => r.expected && !r.called).map((r) => promptOf(r.test))
    const fp = records.filter((r) => !r.expected && r.called).map((r) => promptOf(r.test))
    const hits = records.filter((r) => r.expected === r.called).map((r) => `${r.expected ? 'use' : 'skip'}: ${promptOf(r.test)}`)
    const record: DescriptionStep = { step, trainRun, misses: { falseNegatives: fn, falsePositives: fp }, candidates: [] }
    steps.push(record)
    if (!fn.length && !fp.length) {
      log('no trigger misses on the train split — stopping')
      break
    }

    const skill = readFileSync(join(currentDir, 'SKILL.md'), 'utf8')
    const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n') : '(none)')
    const proposal = await completeJson<{ candidates?: Array<{ description?: string; rationale?: string }> }>(
      opts.optimizer,
      PROPOSE_SYSTEM,
      `# Current skill\n\n${skill}\n\n# Number of candidates\n${opts.candidates ?? 3}\n\n` +
        `# Should have triggered, did not\n${list(fn)}\n\n# Triggered, should not have\n${list(fp)}\n\n` +
        `# Correct decisions (sample)\n${list(hits.slice(0, 12))}\n\n` +
        `# Rejected earlier (selection F1; current is ${current.toFixed(3)})\n` +
        (tried.length ? tried.map((t) => `- F1 ${t.f1.toFixed(3)}: ${t.description}`).join('\n') : '(none)'),
    )
    const candidates = (proposal.candidates ?? [])
      .map((c) => ({ description: (c.description ?? '').trim(), rationale: c.rationale }))
      .filter((c) => c.description && c.description.length <= 1024 && c.description !== currentDesc)
      .slice(0, opts.candidates ?? 3)

    let bestC: (DescriptionCandidate & { dir: string }) | undefined
    for (const [i, c] of candidates.entries()) {
      const dir = join(opts.outDir, `step-${step}`, `candidate-${i + 1}`)
      cpSync(currentDir, dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), withDescription(skill, c.description))
      log(`step ${step} candidate ${i + 1}/${candidates.length}: selection split`)
      const selRun = await evaluate(opts.selFilter, dir, `sel-${step}-${i + 1}`)
      const s = runTriggerScore(selRun, name)
      const scored = { ...c, f1: s.score, precision: s.precision, recall: s.recall, selRun }
      record.candidates.push(scored)
      log(`  F1 ${s.score.toFixed(3)} (P ${fmt(s.precision)} R ${fmt(s.recall)})`)
      if (!bestC || s.score > bestC.f1!) bestC = { ...scored, dir }
    }

    if (bestC && bestC.f1! > current + margin) {
      log(`step ${step}: ACCEPT F1 ${current.toFixed(3)} → ${bestC.f1!.toFixed(3)}`)
      currentDir = bestC.dir
      current = bestC.f1!
      currentDesc = bestC.description
      record.accepted = bestC.description
    } else {
      log(`step ${step}: no candidate beat ${current.toFixed(3)} by more than ${margin}`)
    }
    for (const c of record.candidates) if (c.description !== record.accepted) tried.push({ description: c.description, f1: c.f1! })
    writeFileSync(join(opts.outDir, 'history.json'), JSON.stringify({ steps }, null, 2))
  }

  const bestDir = join(opts.outDir, 'best')
  cpSync(currentDir, bestDir, { recursive: true })
  const result: DescriptionResult = {
    baseline: { description: readDescription(readFileSync(join(opts.skillDir, 'SKILL.md'), 'utf8')), f1: base.score, precision: base.precision, recall: base.recall },
    best: { description: currentDesc, f1: current },
    steps,
    bestDir,
  }
  writeFileSync(join(opts.outDir, 'history.json'), JSON.stringify(result, null, 2))
  return result
}

const fmt = (x: number | null) => (x === null ? '–' : x.toFixed(2))

/** `agentfoo run -t <filter>` with the candidate override and judging switched off. */
function triggerRunner(): NonNullable<Parameters<typeof optimizeDescription>[0]['runner']> {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url))
  return (filter, overrides, runId) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'run', '-t', filter], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: {
          ...process.env,
          AGENTFOO_RUN_ID: runId,
          AGENTFOO_SKILL_OVERRIDES: JSON.stringify(overrides),
          AGENTFOO_TRIGGER_ONLY: '1',
        },
      })
      child.on('error', reject)
      child.on('exit', (code) => {
        const runPath = join(process.cwd(), '.agentfoo', 'runs', runId)
        if (existsSync(join(runPath, 'report.json'))) resolve(runPath)
        else reject(new Error(`agentfoo run ${runId} exited ${code} without a report.json`))
      })
    })
}
