import type { AgentConfig, AgentfooConfig, JudgeConfig } from './types.js'

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
}

const DEFAULTS: ResolvedConfig = {
  judge: { model: 'anthropic/claude-opus-4-8' },
  agents: {},
  retries: 0,
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
  }
  return cached
}

/** Resolve the effective config for one named agent (config default + overrides). */
export function resolveAgentConfig(name: string, override: AgentConfig = {}): AgentConfig {
  const base = loadConfig().agents[name] ?? {}
  return {
    runtime: 'docker',
    memory: false,
    ...base,
    ...stripUndefined(override),
  }
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
