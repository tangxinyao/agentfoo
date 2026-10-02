#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { takeOption } from './cli-args.js'
import { latestRun, suggest } from './suggest.js'
import { optimize } from './optimize.js'
import { serveCompare, serveReview } from './review.js'
import { compare, formatCompare } from './compare.js'
import { optimizeDescription } from './optimize-description.js'
import { formatScore, score } from './score.js'

/**
 * `agentfoo` CLI (§ "CLI 一览"). A thin translation layer over the vitest CLI so
 * the framework's runner/watch/filtering come for free (§2). We only add the
 * agentfoo-specific surface: the `run`/`watch` verbs, `--local` (forces the
 * local runtime via an env flag the fixtures read, §3), `.env` loading, and
 * auto-discovery of `agentfoo.config.ts` (which vitest wouldn't find on its own).
 *
 *   agentfoo run                      → vitest run --config agentfoo.config.ts
 *   agentfoo run skills/frontend      → …run skills/frontend   (path filter)
 *   agentfoo run -t "should trigger"  → …run -t "should trigger"
 *   agentfoo run --local              → AGENTFOO_FORCE_LOCAL=1 …run
 *   agentfoo run -a opencode          → AGENTFOO_AGENT=opencode …run
 *   agentfoo list                     → vitest list  (collect specs, no LLM calls)
 *   agentfoo watch                    → vitest (watch) --config agentfoo.config.ts
 *   agentfoo run --env-file path/.env → load that .env instead of the nearest one
 *   agentfoo suggest skills/foo       → propose bounded SKILL.md edits from the latest run
 *   agentfoo optimize skills/foo --train '\[train/' --sel '\[sel/'
 *                                     → SkillOpt loop: train run → suggest → gated sel run
 *   agentfoo review [--run <id>]      → local page to rate answers, check judge verdicts, edit criteria
 *   agentfoo score --repeat 3 [filters] → run the suite n times; per-case mean ± spread
 *   agentfoo compare <skill-A> <skill-B> [filters] → same suite on two versions + pairwise judge
 *   agentfoo review --compare [<dir>] → blind side-by-side human preference for a compare
 *   agentfoo optimize-description <skill> --train '<p>' --sel '<p>' → tune `description` for trigger F1
 */
function main(): void {
  const rawArgs = process.argv.slice(2)

  // `--env-file <path>` / `--env-file=<path>` lets a suite in a sibling subtree
  // point at a shared .env instead of relying on the cwd-upward walk finding it
  // (which can't reach a sibling repo's file). Consumed here, never forwarded.
  const { value: envFile, args: afterEnvFile } = takeOption(rawArgs, ['--env-file'])

  // `-a <kind>` / `--agent <kind>` picks which configured agent the suite runs
  // against, so one spec set can be pointed at a different agent without editing
  // the fixtures (they must call `bootAgent()` with no kind to opt in). Consumed
  // here — vitest has no such flag and would reject it.
  const { value: agentKind, args: cliArgs } = takeOption(afterEnvFile, ['-a', '--agent'])

  // Load .env (provider keys / model wiring) before we snapshot process.env, so
  // the values reach both this process and the vitest workers we spawn.
  if (envFile) loadEnvFile(resolveCwd(envFile))
  else loadDotenv(process.cwd())

  const [verb, ...rest] = cliArgs

  if (verb === 'score') {
    const { value: repeat, args: vitestArgs } = takeOption(rest, ['--repeat', '-n'])
    const n = Number(repeat ?? 3)
    if (!Number.isInteger(n) || n < 2) {
      console.error('agentfoo score: --repeat must be an integer ≥ 2 (a spread needs at least two runs)')
      process.exit(1)
    }
    if (agentKind) process.env.AGENTFOO_AGENT = agentKind
    const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')
    const outDir = join(process.cwd(), '.agentfoo', 'score', stamp)
    score({ repeat: n, vitestArgs, outDir, log: (m) => console.error(`  agentfoo score  ${m}`) })
      .then((r) => {
        console.log(`\n${formatScore(r)}\n\n  Details: ${join(outDir, 'score.json')}`)
      })
      .catch((err: Error) => {
        console.error(`agentfoo score: ${err.message}`)
        process.exit(1)
      })
    return
  }

  if (verb === 'optimize-description') {
    let args = rest
    const opt = (names: string[]) => {
      const r = takeOption(args, names)
      args = r.args
      return r.value
    }
    const train = opt(['--train'])
    const sel = opt(['--sel'])
    const steps = opt(['--steps'])
    const candidates = opt(['--candidates'])
    const margin = opt(['--margin'])
    const model = opt(['--model'])
    const [skillArg, ...extra] = args
    if (!skillArg || extra.length || !train || !sel) {
      console.error(
        "usage: agentfoo optimize-description <skill-dir> --train '<pattern>' --sel '<pattern>' " +
          '[--steps 3] [--candidates 3] [--margin 0] [--model provider/model]',
      )
      process.exit(1)
    }
    if (agentKind) process.env.AGENTFOO_AGENT = agentKind
    const last = latestRun()
    const optimizerModel =
      model || process.env.AGENTFOO_OPTIMIZER_MODEL || (last ? judgeModelOf(join(process.cwd(), '.agentfoo', 'runs', last)) : undefined)
    if (!optimizerModel) {
      console.error('agentfoo optimize-description: pass --model provider/model or set AGENTFOO_OPTIMIZER_MODEL')
      process.exit(1)
    }
    const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')
    const outDir = join(process.cwd(), '.agentfoo', 'optimize-description', stamp)
    const num = (v: string | undefined) => (v === undefined ? undefined : Number(v))
    optimizeDescription({
      skillDir: resolveCwd(skillArg),
      trainFilter: train,
      selFilter: sel,
      optimizer: { model: optimizerModel },
      outDir,
      steps: num(steps),
      candidates: num(candidates),
      margin: num(margin),
      log: (m) => console.error(`  agentfoo optimize-description  ${m}`),
    })
      .then((r) => {
        console.log(`\n  trigger F1 ${r.baseline.f1.toFixed(3)} → ${r.best.f1.toFixed(3)} on the selection split`)
        console.log(`  before: ${r.baseline.description}`)
        console.log(`  after:  ${r.best.description}`)
        console.log(`\n  Best skill: ${join(r.bestDir, 'SKILL.md')} (only the description differs)`)
        console.log('  The original skill was not modified.')
      })
      .catch((err: Error) => {
        console.error(`agentfoo optimize-description: ${err.message}`)
        process.exit(1)
      })
    return
  }

  if (verb === 'compare') {
    let args = rest
    const opt = (names: string[]) => {
      const r = takeOption(args, names)
      args = r.args
      return r.value
    }
    const judgeModel = opt(['--judge-model'])
    const criteria = opt(['--criteria'])
    const noJudge = args.includes('--no-judge')
    args = args.filter((a) => a !== '--no-judge')
    const [aArg, bArg, ...vitestArgs] = args
    if (!aArg || !bArg) {
      console.error(
        'usage: agentfoo compare <skill-dir-A> <skill-dir-B> [--judge-model p/m] [--criteria "…"] [--no-judge] [vitest filters]',
      )
      process.exit(1)
    }
    if (agentKind) process.env.AGENTFOO_AGENT = agentKind
    const model = judgeModel || process.env.AGENTFOO_OPTIMIZER_MODEL || (() => {
      const last = latestRun()
      return last ? judgeModelOf(join(process.cwd(), '.agentfoo', 'runs', last)) : undefined
    })()
    if (!noJudge && !model) {
      console.error('agentfoo compare: no judge model — pass --judge-model provider/model, or --no-judge for human-only')
      process.exit(1)
    }
    const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')
    const outDir = join(process.cwd(), '.agentfoo', 'compare', stamp)
    compare({
      aDir: resolveCwd(aArg),
      bDir: resolveCwd(bArg),
      vitestArgs,
      judge: noJudge ? undefined : { model: model! },
      criteria,
      outDir,
      log: (m) => console.error(`  agentfoo compare  ${m}`),
    })
      .then((r) => {
        console.log(`\n${formatCompare(r)}\n\n  Details: ${join(outDir, 'compare.json')}`)
        console.log(`  Human blind review: agentfoo review --compare ${outDir}`)
      })
      .catch((err: Error) => {
        console.error(`agentfoo compare: ${err.message}`)
        process.exit(1)
      })
    return
  }

  if (verb === 'review') {
    runReview(rest).catch((err: Error) => {
      console.error(`agentfoo review: ${err.message}`)
      process.exit(1)
    })
    return
  }

  if (verb === 'suggest' || verb === 'optimize') {
    // The runs `optimize` spawns must drive the same agent this invocation was
    // pointed at; `.env` values are already in process.env.
    if (agentKind) process.env.AGENTFOO_AGENT = agentKind
    const job = verb === 'suggest' ? runSuggest(rest) : runOptimize(rest)
    job.catch((err: Error) => {
      console.error(`agentfoo ${verb}: ${err.message}`)
      process.exit(1)
    })
    return
  }

  const env = { ...process.env }
  // The vitest workers write progress to a pipe, not this terminal, so they
  // can't tell whether the final sink is interactive. Propagate our own TTY
  // status so the heartbeat can refresh a line in place (\r) on a real
  // terminal and fall back to plain appended lines when piped/redirected.
  if (process.env.AGENTFOO_TTY === undefined) {
    env.AGENTFOO_TTY = process.stdout.isTTY ? '1' : '0'
    // Also snapshot the terminal width (unreadable from the worker's pipe) so
    // the single-line refresh can truncate itself and never wrap — a wrapped
    // line breaks `\r`, which only returns to the current physical row. A
    // launch-time snapshot is enough for a fallback; a mid-run resize at worst
    // wraps one line.
    if (process.stdout.isTTY && process.stdout.columns) {
      env.AGENTFOO_COLUMNS = String(process.stdout.columns)
    }
  }
  // Register the `.js`→`.ts` resolve shim so vitest can load the TypeScript
  // agentfoo config (and the framework source it pulls in) when running against
  // the raw sources in-repo. No-op against a compiled `.js` build.
  //
  // Note this only covers the *child*. This module's own relative imports need the
  // same shim, which cannot be self-registered from inside it — so running the
  // sources directly requires `node --import scripts/register-ts.mjs src/cli.ts`
  // (what `npm run example` does). The published `bin` is compiled `dist/cli.js`,
  // where `.js` specifiers resolve natively and none of this applies.
  const hook = fileURLToPath(new URL('../scripts/register-ts.mjs', import.meta.url))
  env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${hook}`].filter(Boolean).join(' ')

  if (agentKind !== undefined) {
    if (!agentKind || agentKind.startsWith('-')) {
      console.error('-a/--agent needs an agent kind, e.g. `agentfoo run -a opencode`.')
      process.exit(1)
    }
    env.AGENTFOO_AGENT = agentKind
  }

  const passthrough: string[] = []
  for (const arg of rest) {
    if (arg === '--local') env.AGENTFOO_FORCE_LOCAL = '1'
    else passthrough.push(arg)
  }

  const config = configArgs(process.cwd(), passthrough)

  let vitestArgs: string[]
  switch (verb) {
    case undefined:
    case 'run':
      vitestArgs = ['run', ...config, ...passthrough]
      break
    case 'watch':
      vitestArgs = [...config, ...passthrough] // vitest defaults to watch
      break
    case 'list':
      // Collect + print the matched specs without running them — a zero-cost
      // wiring self-check (config/fixtures/specs all resolve) that never boots a
      // container or makes an LLM call.
      vitestArgs = ['list', ...config, ...passthrough]
      break
    default:
      // Treat a bare path/filter as `run <path>` (agentfoo skills/foo).
      vitestArgs = ['run', verb, ...config, ...passthrough]
  }

  launchVitest(vitestArgs, env)
}

/**
 * `agentfoo suggest <skill-dir> [--run <id>] [--budget n] [--batch n] [--model provider/model]`
 *
 * No vitest involved: reads a finished run's artifacts and calls the optimizer
 * model directly. The optimizer defaults to `AGENTFOO_OPTIMIZER_MODEL`, else the
 * judge model recorded in that run's gradings — the CLI doesn't load
 * agentfoo.config.ts, and the run already says which model graded it.
 */
async function runSuggest(argv: string[]): Promise<void> {
  const run = takeOption(argv, ['--run'])
  const budget = takeOption(run.args, ['--budget'])
  const batch = takeOption(budget.args, ['--batch'])
  const model = takeOption(batch.args, ['--model'])
  const [skillArg, ...extra] = model.args
  if (!skillArg || extra.length) {
    throw new Error(
      'usage: agentfoo suggest <skill-dir> [--run <run-id>] [--budget 4] [--batch 8] [--model provider/model]',
    )
  }
  const skillDir = resolveCwd(skillArg)
  if (!existsSync(join(skillDir, 'SKILL.md'))) throw new Error(`no SKILL.md in ${skillDir}`)

  const runId = run.value || latestRun()
  if (!runId) throw new Error('no run with a report.json under .agentfoo/runs — run the eval first')
  const runPath = join(process.cwd(), '.agentfoo', 'runs', runId)

  const optimizerModel = model.value || process.env.AGENTFOO_OPTIMIZER_MODEL || judgeModelOf(runPath)
  if (!optimizerModel) {
    throw new Error('no optimizer model: pass --model provider/model or set AGENTFOO_OPTIMIZER_MODEL')
  }

  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')
  const outDir = join(process.cwd(), '.agentfoo', 'suggest', `${runId}__${stamp}`)
  const log = (msg: string) => console.error(`  agentfoo suggest  ${msg}`)
  log(`run ${runId}, optimizer ${optimizerModel}`)

  const result = await suggest({
    skillDir,
    runPath,
    optimizer: { model: optimizerModel },
    budget: budget.value ? Number(budget.value) : undefined,
    batchSize: batch.value ? Number(batch.value) : undefined,
    outDir,
    log,
  })

  const applied = result.results.filter((r) => r.applied).length
  console.log(`\n  ${applied}/${result.results.length} edits applied to a copy of SKILL.md`)
  for (const r of result.results) {
    console.log(`    ${r.applied ? '✓' : '✗'} ${r.edit.op}: ${r.edit.rationale.slice(0, 100)}${r.applied ? '' : ` (${r.reason})`}`)
  }
  console.log(`\n  Review: ${join(outDir, 'suggestions.md')}`)
  console.log(`  Diff:   ${join(outDir, 'SKILL.md.diff')}`)
}

/**
 * `agentfoo optimize <skill-dir> --train <pattern> --sel <pattern> [--epochs 2]
 *  [--steps 2] [--budget 4] [--min-budget 2] [--margin 0] [--model provider/model]`
 *
 * `--train` / `--sel` are vitest `-t` name patterns picking each split out of the
 * suite. Spawns `agentfoo run` for every evaluation, so a full default run is
 * 1 + 4×2 = 9 suite runs — plan the cost before starting one.
 */
async function runOptimize(argv: string[]): Promise<void> {
  let args = argv
  const opt = (names: string[]) => {
    const r = takeOption(args, names)
    args = r.args
    return r.value
  }
  const train = opt(['--train'])
  const sel = opt(['--sel'])
  const epochs = opt(['--epochs'])
  const steps = opt(['--steps'])
  const budget = opt(['--budget'])
  const minBudget = opt(['--min-budget'])
  const margin = opt(['--margin'])
  const baselineRuns = opt(['--baseline-runs'])
  const gate = opt(['--gate'])
  const model = opt(['--model'])
  const noSlow = args.includes('--no-slow-update')
  const noMeta = args.includes('--no-meta')
  args = args.filter((a) => a !== '--no-slow-update' && a !== '--no-meta')
  if (gate !== undefined && gate !== 'score' && gate !== 'pairwise') throw new Error('--gate must be score or pairwise')
  const [skillArg, ...extra] = args
  if (!skillArg || extra.length || !train || !sel) {
    throw new Error(
      "usage: agentfoo optimize <skill-dir> --train '<pattern>' --sel '<pattern>' [--epochs 2] [--steps 2] " +
        '[--budget 4] [--min-budget 2] [--margin 0|auto] [--baseline-runs n] [--gate score|pairwise] ' +
        '[--no-slow-update] [--no-meta] [--model provider/model]',
    )
  }
  const skillDir = resolveCwd(skillArg)
  if (!existsSync(join(skillDir, 'SKILL.md'))) throw new Error(`no SKILL.md in ${skillDir}`)
  const last = latestRun()
  const optimizerModel =
    model || process.env.AGENTFOO_OPTIMIZER_MODEL || (last ? judgeModelOf(join(process.cwd(), '.agentfoo', 'runs', last)) : undefined)
  if (!optimizerModel) {
    throw new Error('no optimizer model: pass --model provider/model or set AGENTFOO_OPTIMIZER_MODEL')
  }

  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')
  const outDir = join(process.cwd(), '.agentfoo', 'optimize', stamp)
  const log = (msg: string) => console.error(`  agentfoo optimize  ${msg}`)
  log(`optimizer ${optimizerModel}, output ${outDir}`)

  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v))
  const result = await optimize({
    skillDir,
    trainFilter: train,
    selFilter: sel,
    optimizer: { model: optimizerModel },
    outDir,
    epochs: num(epochs),
    stepsPerEpoch: num(steps),
    budget: num(budget),
    minBudget: num(minBudget),
    margin: margin === 'auto' ? 'auto' : num(margin),
    baselineRuns: num(baselineRuns),
    gate: gate as 'score' | 'pairwise' | undefined,
    slowUpdate: !noSlow,
    metaMemory: !noMeta,
    log,
  })

  const accepted = result.steps.filter((s) => s.accepted).length
  console.log(
    `\n  selection score ${result.baseline.toFixed(3)} → ${result.best.toFixed(3)} ` +
      `(${accepted}/${result.steps.length} steps accepted)`,
  )
  console.log(`  Best skill: ${join(result.bestDir, 'SKILL.md')}`)
  console.log(`  History:    ${join(outDir, 'history.json')}`)
  console.log('  The original skill was not modified; the test split was never run — evaluate best/ on it yourself.')
}

/** `agentfoo review [--run <id>] [--port 4173]` — serve the human review page until Ctrl-C. */
async function runReview(argv: string[]): Promise<void> {
  const run = takeOption(argv, ['--run'])
  const port = takeOption(run.args, ['--port'])
  const cmp = takeOption(port.args, ['--compare'])
  if (cmp.value !== undefined || argv.includes('--compare')) {
    const dir = cmp.value ? resolveCwd(cmp.value) : latestCompare()
    if (!dir) throw new Error('no compare under .agentfoo/compare — run agentfoo compare first')
    const { url } = await serveCompare(dir, port.value ? Number(port.value) : 4174)
    console.log(`\n  Blind comparison ${dir}`)
    console.log(`  Open ${url}  (127.0.0.1 only; remote: ssh -L ${new URL(url).port}:127.0.0.1:${new URL(url).port} <host>)`)
    console.log(`  Saves to ${join(dir, 'preferences.json')}. Ctrl-C to stop.\n`)
    return
  }
  if (cmp.args.length) throw new Error('usage: agentfoo review [--run <run-id>] [--port 4173] | --compare [<dir>]')
  const runId = run.value || latestRun()
  if (!runId) throw new Error('no run with a report.json under .agentfoo/runs — run the eval first')
  const runPath = join(process.cwd(), '.agentfoo', 'runs', runId)
  const { url } = await serveReview(runPath, port.value ? Number(port.value) : 4173)
  console.log(`\n  Reviewing run ${runId}`)
  console.log(`  Open ${url}  (bound to 127.0.0.1; on a remote host: ssh -L ${new URL(url).port}:127.0.0.1:${new URL(url).port} <host>)`)
  console.log(`  Saves to ${join(runPath, 'review.json')} as you go. Ctrl-C to stop.\n`)
}

function latestCompare(): string | undefined {
  const root = join(process.cwd(), '.agentfoo', 'compare')
  if (!existsSync(root)) return undefined
  const last = readdirSync(root).filter((d) => existsSync(join(root, d, 'compare.json'))).sort().at(-1)
  return last ? join(root, last) : undefined
}

/** The judge model named in any grading of this run, for a default optimizer. */
function judgeModelOf(runPath: string): string | undefined {
  const entries = readdirSync(runPath, { recursive: true }) as string[]
  const file = entries.find((e) => /(^|\/)judge-\d+\.json$/.test(e))
  if (!file) return undefined
  return (JSON.parse(readFileSync(join(runPath, file), 'utf8')) as { model?: string }).model
}

/**
 * Locate vitest's bin entry and spawn it via this same node, instead of relying
 * on `vitest` being on PATH. `npm link` does not install a linked package's
 * dependencies into the consumer, so its `node_modules/.bin/vitest` never lands
 * on the consumer's PATH; resolving from agentfoo's own module graph makes link,
 * monorepo, and hoisted layouts all work. Falls back to a PATH lookup if the
 * resolution ever fails (e.g. an exotic package layout).
 */
function launchVitest(vitestArgs: string[], env: NodeJS.ProcessEnv): void {
  const bin = resolveVitestBin()
  const [cmd, argv] = bin
    ? [process.execPath, [bin, ...vitestArgs]]
    : ['vitest', vitestArgs]
  const child = spawn(cmd, argv, { stdio: 'inherit', env })
  child.on('exit', (code) => process.exit(code ?? 1))
  child.on('error', (err) => {
    const hint = bin
      ? ''
      : '\nCould not resolve the `vitest` package from agentfoo. If you installed ' +
        'agentfoo via `npm link`, also add vitest to your project: ' +
        '`npm install --save-dev vitest`.'
    console.error(`Failed to launch vitest: ${err.message}${hint}`)
    process.exit(1)
  })
}

/** Absolute path to vitest's bin JS, or undefined if it can't be resolved. */
function resolveVitestBin(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const pkgPath = require.resolve('vitest/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> }
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.vitest
    if (!rel) return undefined
    return join(dirname(pkgPath), rel)
  } catch {
    return undefined
  }
}

function resolveCwd(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

/**
 * Point vitest at `agentfoo.config.ts` in the cwd unless the caller already
 * passed a `--config`. vitest only auto-discovers `vitest.config.*`, so without
 * this an agentfoo project's config would be silently ignored.
 */
function configArgs(cwd: string, passthrough: string[]): string[] {
  const explicit = passthrough.some(
    (a) => a === '-c' || a === '--config' || a.startsWith('--config='),
  )
  if (explicit) return []
  const cfg = join(cwd, 'agentfoo.config.ts')
  return existsSync(cfg) ? ['--config', cfg] : []
}

/**
 * Minimal `.env` loader: walk up from `startDir` to the nearest `.env` and load
 * `KEY=VALUE` pairs. Existing environment variables win (a real `export` beats
 * the file), matching dotenv convention. Kept dependency-free and deliberately
 * small — quoting and `export` prefixes are handled; interpolation is not.
 */
function loadDotenv(startDir: string): void {
  let dir = startDir
  for (;;) {
    const file = join(dir, '.env')
    if (existsSync(file)) {
      loadEnvFile(file)
      return
    }
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

/** Load one explicit `.env` file (existing env vars win, dotenv convention). */
function loadEnvFile(file: string): void {
  if (!existsSync(file)) {
    console.error(`--env-file: no such file: ${file}`)
    process.exit(1)
  }
  for (const [key, value] of Object.entries(parseDotenv(readFileSync(file, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let val = m[2].trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    out[m[1]] = val
  }
  return out
}

main()
