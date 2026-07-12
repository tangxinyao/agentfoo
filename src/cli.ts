#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 *   agentfoo watch                    → vitest (watch) --config agentfoo.config.ts
 */
function main(): void {
  // Load .env (provider keys / model wiring) before we snapshot process.env, so
  // the values reach both this process and the vitest workers we spawn.
  loadDotenv(process.cwd())

  const [verb, ...rest] = process.argv.slice(2)

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
  const hook = fileURLToPath(new URL('../scripts/register-ts.mjs', import.meta.url))
  env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${hook}`].filter(Boolean).join(' ')

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
    default:
      // Treat a bare path/filter as `run <path>` (agentfoo skills/foo).
      vitestArgs = ['run', verb, ...config, ...passthrough]
  }

  const child = spawn('vitest', vitestArgs, { stdio: 'inherit', env })
  child.on('exit', (code) => process.exit(code ?? 1))
  child.on('error', (err) => {
    console.error(`Failed to launch vitest: ${err.message}`)
    process.exit(1)
  })
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
      for (const [key, value] of Object.entries(parseDotenv(readFileSync(file, 'utf8')))) {
        if (process.env[key] === undefined) process.env[key] = value
      }
      return
    }
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
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
