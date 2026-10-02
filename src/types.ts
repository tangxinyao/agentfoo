/**
 * Public type surface for agentfoo.
 *
 * These types are intentionally small and stable: §2 of the design doc treats
 * the vitest foundation as a revisitable bet, so the interface layer must not
 * leak vitest internals to test authors.
 */

export type Runtime = 'docker' | 'local'

/**
 * The agent kinds agentfoo ships built-in adapters for. `hermes` and `opencode`
 * each have their own native CLI adapter; `pi` and `openclaw` are driven through
 * the shared acpx ACP client (`acpx <agent>`).
 */
export type KnownAgentKind = 'hermes' | 'opencode' | 'pi' | 'openclaw'

/**
 * Which coding agent is under test. The four {@link KnownAgentKind}s work out of
 * the box; any other string is valid too once registered at runtime via
 * `registerAgent` / `registerCommandAgent` (§7), so bring-your-own agents need no
 * change here. The `string & {}` member keeps editor autocomplete for the known
 * kinds while still accepting arbitrary custom names.
 */
export type AgentKind = KnownAgentKind | (string & {})

/** Resolved configuration for a single agent instance. */
export interface AgentConfig {
  /**
   * Model id, optionally provider-prefixed like the judge (`anthropic/claude-sonnet-5`
   * or a bare `claude-sonnet-5`). A prefix populates `provider` when it isn't set
   * explicitly; an explicit `provider` always wins and the prefix is stripped.
   */
  model?: string
  /** Inference provider passed to the agent CLI (hermes `--provider`). Overrides any `model` prefix. */
  provider?: string
  /**
   * Base URL for the provider's OpenAI-compatible endpoint, written into the
   * container's hermes `config.yaml` (`model.base_url`). Needed for providers
   * hermes doesn't have a built-in default for (e.g. deepseek).
   */
  baseUrl?: string
  /** docker (default, CI-safe) or local (dev escape hatch, §3). */
  runtime?: Runtime
  /**
   * Prebuilt docker image carrying the hermes binary. One of `image` or
   * `dockerfile` is required for `runtime: 'docker'`.
   */
  image?: string
  /**
   * Path to a Dockerfile to build the test image from (relative to the config
   * file / cwd). agentfoo builds it once, tags it by content hash, and reuses
   * the tag across runs. Takes precedence over `image` when both are set.
   */
  dockerfile?: string
  /** Build context dir for `dockerfile`. Defaults to the Dockerfile's dir. */
  buildContext?: string
  /**
   * Names of host environment variables to forward into the runtime on every
   * command (provider API keys / credentials, e.g. `['DEEPSEEK_API_KEY']`).
   * Values are read from the host `process.env` at run time so secrets never
   * live in the config file or the image.
   */
  passEnv?: string[]
  /**
   * Disable the agent's self-learning / memory so repeated runs stay
   * reproducible (§7). Defaults to true; only turn off when the test target
   * *is* the self-evolution behaviour.
   */
  memory?: boolean
  /** Extra raw CLI flags appended verbatim. Escape hatch, use sparingly. */
  extraArgs?: string[]
}

/** A single tool invocation as recorded in the agent trace. */
export interface ToolCall {
  /** Function/tool name, e.g. `bash`, `edit_file`, `skill_view`. */
  name: string
  /** Parsed arguments object (best-effort; raw string kept in `rawArguments`). */
  arguments: Record<string, unknown>
  rawArguments?: string
  /** Correlates a call with its result message, when the agent provides ids. */
  id?: string
  /** Tool result / observation text, when resolvable. */
  result?: string
}

export type TraceRole = 'system' | 'user' | 'assistant' | 'tool'

export interface TraceMessage {
  role: TraceRole
  content: string
  toolCalls?: ToolCall[]
  /** For role === 'tool': which call this responds to. */
  toolCallId?: string
  toolName?: string
  /**
   * The model's reasoning/thinking for this turn, when the agent exports it
   * (hermes `reasoning`/`reasoning_content`; ACP `agent_thought_chunk`).
   *
   * Kept because for some agents it is the *only* observable signal that a
   * preloaded skill fired — hermes activates skills from its system prompt with
   * no corresponding tool call, and names the skill only here (TODO §5).
   * Deliberately excluded from {@link Trace.text} so it never pollutes the
   * judge-graded transcript.
   */
  reasoning?: string
}

/** One entry from an agent's advertised slash/skill command list (ACP `available_commands_update`). */
export interface AvailableCommand {
  name: string
  description?: string
}

/**
 * Normalized conversation trace, shaped after an OpenAI chat transcript
 * (§7 / §10 — we deliberately do not invent a new schema). Every agent's wire
 * envelope is decoded into this by one of the parsers in `src/trace.ts`.
 */
export interface Trace {
  /** Messages in emission order; a tool result follows the turn that called it. */
  messages: TraceMessage[]
  /** Flattened tool calls across all assistant turns, in order. */
  toolCalls: ToolCall[]
  /** Last assistant text message. */
  finalMessage: string
  /**
   * The CLI's own parsed records, exactly as it emitted them — never the
   * normalized/synthesized messages — so the escape hatch can reach anything
   * this layer drops.
   */
  raw: unknown[]
  /**
   * The agent's advertised slash/skill commands, when the wire envelope carries
   * one (ACP `available_commands_update` — TODO §P1). Undefined for an envelope
   * that has no such concept (opencode) or a stream that never sent one.
   */
  availableCommands?: AvailableCommand[]
  /**
   * Full rendered transcript, tool results included. `toSatisfy` grades this only
   * with `{ target: 'transcript' }` — by default it grades {@link finalMessage},
   * because the transcript also carries whatever files the agent read, and for
   * agents that load a skill by reading SKILL.md (pi, openclaw) that means the
   * skill's own instructions end up graded as if they were the answer.
   */
  text(): string
}

/** A single weighted rubric criterion for LLM-judge assertions (§5). */
export interface RubricCriterion {
  criteria: string
  weight?: number
}

export type Rubric = string | RubricCriterion[]

/** What part of a {@link Trace} `toSatisfy` hands to the judge. */
export type SatisfyTarget = 'final' | 'transcript'

export interface SatisfyOptions {
  /** Pass threshold in [0,1] for weighted rubrics. Default 1 for single. */
  threshold?: number
  /** Override judge model for this single call (syntactic sugar, §6). */
  model?: string
  /**
   * Only applies when the received value is a {@link Trace}. `'final'` (default)
   * grades `trace.finalMessage`; `'transcript'` grades `trace.text()`, the whole
   * rendered conversation including tool calls and their results. Opt into the
   * transcript only when the rubric is about the *process* (which tools were
   * used, in what order) — it also contains any SKILL.md the agent read, which a
   * judge will happily credit as part of the answer.
   */
  target?: SatisfyTarget
  /**
   * Grade this many times and aggregate (default: `judge.samples` from the
   * config, else 1). An LLM judge is not deterministic — the same answer and
   * rubric graded three times by deepseek-flash came back ✗✗✓ / ✓✓✓ / ✗✓✗ — so a
   * single grading can't separate a real change from noise. The score becomes
   * the mean, each criterion is met by majority, and the record keeps every
   * sample's score and the standard deviation.
   */
  samples?: number
}

/**
 * One trigger assertion (`expect(skill).toHaveBeenCalled()` or its `.not`), as
 * persisted to `trigger-<n>.json`. Kept apart from the test's pass/fail because
 * a test can fail on its rubric after triggering correctly — and the
 * description-optimization loop needs exactly this signal: did the skill fire,
 * and should it have.
 */
export interface TriggerRecord {
  test: string
  index: number
  skill: string
  /** Whether the skill was detected as invoked. */
  called: boolean
  /** Whether the assertion expected it to be (`toHaveBeenCalled` vs `.not`). */
  expected: boolean
  recordedAt: string
}

/**
 * One `toSatisfy` grading, as persisted to `judge-<n>.json` next to the test's
 * turn artifacts and summarized into `report.json`.
 */
export interface JudgeRecord {
  /** vitest's `currentTestName` ("describe > it"). */
  test: string
  /** 1-based index of this grading within the test. */
  index: number
  model: string
  /** `'string'` when a plain string was graded rather than a Trace. */
  target: SatisfyTarget | 'string'
  threshold: number
  score: number
  passed: boolean
  breakdown: JudgeResult['breakdown']
  /** Number of gradings aggregated into this record (1 unless `samples` was set). */
  samples: number
  /** Every sample's score, in order; `score` is their mean. */
  scores: number[]
  /** Population standard deviation of `scores` (0 for a single sample). */
  stdev: number
  gradedAt: string
}

/** Pass-decision strategy for {@link retry} (§5). */
export type RetryPolicy = 'any' | 'majority'

export interface RetryOptions {
  /**
   * Total attempts (not extra retries). Defaults to the config `retries` value
   * + 1, so `retries: 0` → a single attempt (retry off).
   */
  attempts?: number
  /** 'any' (default): pass if any attempt succeeds. 'majority': strict majority. */
  policy?: RetryPolicy
}

export interface JudgeResult {
  passed: boolean
  score: number
  threshold: number
  /** Per-criterion breakdown for artifact/debugging output. */
  breakdown: Array<{
    criteria: string
    weight: number
    met: boolean
    reason: string
    /** Fraction of samples that judged this criterion met; only set when `samples > 1`. */
    metRate?: number
  }>
}

export interface JudgeConfig {
  /** Provider-prefixed model string, e.g. `anthropic/claude-opus-4-8`, `deepseek/deepseek-chat`. */
  model: string
  /**
   * Explicit provider override. Normally derived from the `model` prefix; set
   * this only to point a bare (un-prefixed) model at a known provider, or to
   * reuse a provider's request/response shape against a custom `baseUrl`.
   */
  provider?: string
  /**
   * Override the provider's default API endpoint (e.g. an OpenAI-compatible
   * gateway or a self-hosted proxy). Uses the resolved provider's request shape.
   */
  baseUrl?: string
  /**
   * Override which host env var holds the API key. Defaults to the provider's
   * conventional variable (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, …).
   */
  apiKeyEnv?: string
  /**
   * Output-token cap for one grading call. The verdict JSON itself is small,
   * but reasoning models (deepseek-reasoner, deepseek-v4-pro, …) bill their
   * hidden chain-of-thought against this same budget and can burn thousands of
   * tokens before emitting the first character of JSON — so the default is
   * deliberately roomy. Lower it only for a known non-reasoning judge.
   */
  maxTokens?: number
  /** Default for {@link SatisfyOptions.samples}: how many times each `toSatisfy` grades. Default 1. */
  samples?: number
}

export interface AgentfooConfig {
  judge?: Partial<JudgeConfig>
  agents?: Record<string, AgentConfig>
  /** Retry a failing test N times (§5). Default 0 (off). */
  retries?: number
  /**
   * Per-test / per-hook timeout in ms. A single agent turn is a full LLM
   * round-trip (optionally + a container boot), so this is deliberately large.
   * Default 300_000 (5 min).
   */
  timeout?: number
  /**
   * How many `test.concurrent` cases may run at once within a spec file, and the
   * default size of {@link createAgentPool}. Default 1: everything serial, the
   * safe setting for containers and rate-limited APIs. Raise it only together with
   * a pool — concurrent tests sharing one file-scoped agent would interleave turns
   * in a single session. Size it to host memory (a pi container is ~270MB).
   */
  concurrency?: number
  /** vitest passthrough. */
  setupFiles?: string[]
  include?: string[]
}
