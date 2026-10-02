#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { takeOption } from './cli-args.js'

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
