import type { AgentConfig, AgentfooConfig, JudgeConfig } from './types.js'
import { providerMeta } from './providers.js'

/**
 * Config as seen from *inside* a test worker.
 *
 * `defineConfig` serializes the agentfoo-specific config into the
 * `AGENTFOO_CONFIG` env var (vitest forwards `test.env` to every worker), and
 * this module reads it back with defaults applied. Keeping the read behind one
 * function means the fixtures and matchers never parse env directly.
 */

export interface ResolvedConfig {
  judge: JudgeConfig
  agents: Record<string, AgentConfig>
  retries: number
  concurrency: number
  /**
   * Per-test/per-hook timeout (ms) as declared in `agentfoo.config.ts`. Workers
   * use it to derive the per-turn budget an adapter enforces itself (see
   * `turnBudgetMs` in fixtures.ts) — without it the only bound on a turn is
   * vitest's test timeout, which fires while the turn keeps running.
   */
  timeout?: number
}

const DEFAULTS: ResolvedConfig = {
  judge: { model: 'anthropic/claude-opus-4-8' },
  agents: {},
  retries: 0,
  concurrency: 1,
}

let cached: ResolvedConfig | undefined

export function loadConfig(): ResolvedConfig {
  if (cached) return cached
  const raw = process.env.AGENTFOO_CONFIG
  if (!raw) {
    cached = DEFAULTS
    return cached
  }
  const parsed = JSON.parse(raw) as AgentfooConfig
  cached = {
    judge: { ...DEFAULTS.judge, ...parsed.judge },
    agents: parsed.agents ?? {},
    retries: parsed.retries ?? 0,
    concurrency: Math.max(1, Math.floor(parsed.concurrency ?? 1)),
    ...(parsed.timeout !== undefined ? { timeout: parsed.timeout } : {}),
  }
  return cached
}

/**
 * Which agent kind a fixture that calls `bootAgent()` without a kind should boot.
 *
 * Resolution order:
 *  1. the CLI's `-a/--agent` (via `AGENTFOO_AGENT`) — lets one spec set be pointed
 *     at a different agent without editing fixtures;
 *  2. otherwise the single entry in `agents`, when there is exactly one.
 *
 * Anything else throws, because guessing would silently run the suite against the
 * wrong agent — a failure that looks like a skill regression. A kind that isn't in
 * `agents` is rejected too (typo protection), except when no agents are configured
 * at all, which is the legitimate shape for a `registerAgent` bring-your-own agent
 * that needs no config block.
 */
export function selectedAgentKind(): string {
  const configured = Object.keys(loadConfig().agents)
  const requested = process.env.AGENTFOO_AGENT?.trim()

  if (requested) {
    if (configured.length > 0 && !configured.includes(requested)) {
      throw new Error(
        `-a/--agent: no agent named "${requested}" in agentfoo.config.ts. ` +
          `Configured agents: ${configured.join(', ')}.`,
      )
    }
    return requested
  }

  if (configured.length === 1) return configured[0]

  if (configured.length === 0) {
    throw new Error(
      'bootAgent() needs an agent kind: agentfoo.config.ts declares no `agents`. ' +
        'Add one, pass the kind explicitly (bootAgent("hermes")), or select one with `-a <kind>`.',
    )
  }

  throw new Error(
    `bootAgent() is ambiguous: agentfoo.config.ts declares ${configured.length} agents ` +
      `(${configured.join(', ')}). Select one with \`-a <kind>\` or pass the kind explicitly ` +
      '(bootAgent("hermes")).',
  )
}

/** Resolve the effective config for one named agent (config default + overrides). */
export function resolveAgentConfig(name: string, override: AgentConfig = {}): AgentConfig {
  const base = loadConfig().agents[name] ?? {}
  const merged: AgentConfig = {
    runtime: 'docker',
    memory: false,
    ...base,
    ...stripUndefined(override),
  }
  return applyProviderDefaults(merged)
}

/**
 * Fill in a known provider's conventional endpoint + key env var so a bare
 * `provider: 'glm'` (or a `glm/…` model prefix) works without hand-writing the
 * base URL or `passEnv`. Explicit values always win; unknown providers pass
 * through untouched.
 */
function applyProviderDefaults(config: AgentConfig): AgentConfig {
  const provider =
    config.provider ??
    (config.model?.includes('/') ? config.model.slice(0, config.model.indexOf('/')) : undefined)
  const meta = provider ? providerMeta(provider) : undefined
  if (!meta) return config

  const out = { ...config }
  if (!out.baseUrl && meta.apiBase) out.baseUrl = meta.apiBase
  if ((!out.passEnv || out.passEnv.length === 0) && meta.apiKeyEnv.length) {
    out.passEnv = [...meta.apiKeyEnv]
  }
  return out
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>
}

/** Test-only: reset the memoized config (used by unit tests). */
export function __resetConfigCache(): void {
  cached = undefined
}

/**
 * Per-turn budget handed to every adapter: the suite's `timeout` less a margin,
 * so a runaway turn is killed *inside* its own test instead of outliving it.
 *
 * That failure mode produced three separate defects in one regression run
 * (2026-10-01): artifacts filed under the *next* test, that test's negative
 * assertion poisoned by the previous turn's late-arriving trace, and 20+ minutes
 * of real spend per stuck turn. Suites with a small timeout get no adapter-level
 * bound at all — subtracting the margin would leave a nonsensical budget — and
 * keep relying on vitest's own timeout, exactly as before.
 */
export const TURN_TIMEOUT_MARGIN_MS = 30_000

/** Below this suite timeout the margin would eat the whole budget, so adapters stay unbounded. */
export const TURN_TIMEOUT_MIN_MS = 60_000

export function turnBudgetMs(): number | undefined {
  const { timeout } = loadConfig()
  if (!timeout || timeout <= TURN_TIMEOUT_MIN_MS) return undefined
  return timeout - TURN_TIMEOUT_MARGIN_MS
}
