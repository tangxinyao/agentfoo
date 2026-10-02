import type { AgentConfig, Trace } from '../types.js'
import type { RuntimeEnv } from '../runtime/types.js'
import type { SkillHandle } from '../skill.js'

/**
 * The contract every coding-agent adapter implements, and the only surface the
 * fixture layer ({@link file://../fixtures.ts}) and matchers depend on. Keeping
 * it small lets agentfoo swap between hermes / opencode / acpx-driven agents
 * (pi, openclaw, …) without touching test-author-facing code.
 */
export interface RunOptions {
  /** Per-turn limit in ms. */
  timeout?: number
}

export interface Agent {
  /** Path, inside the runtime, that runs use as their working directory. */
  readonly workspacePath: string
  /** Traces accumulated so far, one per `run()`, in order. Spy target for skills. */
  readonly traces: Trace[]
  /** Write the agent's config into its isolated home before the first run. */
  init(): Promise<void>
  /**
   * Copy a skill directory in so it can be preloaded; returns a spy handle.
   * `{ force: true }` (forced mode, TODO §P1) deterministically injects the
   * skill's content, skipping the agent's own discovery step — useful for
   * grading a SKILL.md's content quality independent of whether the model
   * would have chosen to load it. Only adapters with a verified forcing lever
   * support it; others throw. Never combine with `toHaveBeenCalled` on the
   * returned handle (it throws) — use `toSatisfy` instead.
   */
  loadSkill(hostPath: string, opts?: { force?: boolean }): Promise<SkillHandle>
  /** Seed initial workspace files. Only callable once per instance (§4). */
  loadWorkspace(hostPath: string): Promise<string>
  /**
   * One conversation turn; subsequent calls continue the same session (§4).
   * `timeout` (ms) bounds this turn alone: the agent process is killed and the
   * call rejects naming the turn, instead of the whole test timing out with a
   * generic message while the agent keeps running.
   */
  run(prompt: string, opts?: RunOptions): Promise<Trace>
  /** Start a fresh session on the next run() without tearing down the env (§4). */
  reset(): void
  teardown(): Promise<void>
}

/**
 * Everything an adapter needs to boot. Shared across adapters so the fixture
 * layer constructs any agent kind the same way (via the registry).
 */
export interface AgentBootOptions {
  env: RuntimeEnv
  config: AgentConfig
  /** Unique tag so a session lookup can find this instance's sessions. */
  sourceTag: string
  /**
   * Called after every `run()` with the turn's trace and the raw session export.
   * Used by the fixture layer to drop per-test artifacts (§9) without coupling
   * an adapter to vitest or the filesystem layout.
   */
  onTrace?: (info: { trace: Trace; sessionJsonl: string }) => void
  /**
   * Identifies the currently executing test. When it changes between `run()`s,
   * the session is reset so each test starts a fresh conversation. Injected by
   * the fixture layer so adapters stay vitest-agnostic (§7).
   */
  currentTest?: () => string | undefined
}
