import type { ToolCall, Trace } from './types.js'

/**
 * A skill-invocation detector: given a trace and the skill name, return the
 * tool calls that represent that skill firing. See {@link setSkillDetector}.
 */
export type SkillDetector = (trace: Trace, skillName: string) => ToolCall[]

let customDetector: SkillDetector | undefined

/**
 * Override the built-in skill-invocation heuristic (§11). Because the "which
 * tool_call means a skill fired" signal is agent- and version-specific and the
 * built-in {@link detectSkillInvocations} is an explicitly UNVERIFIED guess,
 * a suite that has observed its own agent's real traces can pin the signal
 * exactly. Call this from a `setupFiles` module (it runs inside each worker):
 *
 * ```ts
 * import { setSkillDetector } from 'agentfoo'
 * setSkillDetector((trace, name) =>
 *   trace.toolCalls.filter((c) => c.name === 'skill_view' && c.arguments.name === name))
 * ```
 *
 * Pass `undefined` to restore the default.
 */
export function setSkillDetector(fn: SkillDetector | undefined): void {
  customDetector = fn
}

/** The active detector: the custom override if set, else the built-in guess. */
export function activeDetector(): SkillDetector {
  return customDetector ?? detectSkillInvocations
}

/**
 * Detect whether a given skill was invoked within a trace.
 *
 * ⚠️ §11 PARTIALLY VERIFIED. The acpx/hermes trace *shape* is now pinned (TODO
 * §VI): a tool call surfaces as an ACP `tool_call` whose machine `kind` becomes
 * {@link ToolCall.name} (e.g. `execute`) and whose human `title` + payload land
 * in {@link ToolCall.arguments} (`title` / `text`). What a *skill* firing looks
 * like specifically — a dedicated tool `kind`, or the skill name in the title —
 * still needs a real skill-firing trace to pin. This heuristic therefore checks
 * both the classic `skill_view`-style name and the ACP title/text, and stays the
 * single place to fix; everything downstream (`toHaveBeenCalled`) depends only on
 * this contract, and a suite can replace it wholesale via {@link setSkillDetector}.
 */
export function detectSkillInvocations(trace: Trace, skillName: string): ToolCall[] {
  const needle = skillName.toLowerCase()
  return trace.toolCalls.filter((call) => {
    const name = call.name.toLowerCase()

    // (a) A skill-machinery tool call (skill_view / skill / use_skill / load_skill…)
    // whose arguments name this skill.
    if (name.includes('skill')) {
      if (argMentions(call, needle)) return true
      // A bare skill call with no discernible target — attribute conservatively
      // only when there is a single skill under test is handled by the caller.
    }

    // (b) The tool is literally named after the skill (some agents expose each
    // preloaded skill as its own callable).
    if (name === needle || name === needle.replace(/-/g, '_')) return true

    return false
  })
}

function argMentions(call: ToolCall, needle: string): boolean {
  // `title` / `text` are the ACP tool_call fields (TODO §VI); the rest cover
  // OpenAI-style skill-machinery tool calls.
  for (const key of ['name', 'skill', 'skill_name', 'id', 'path', 'title', 'text']) {
    const v = call.arguments[key]
    if (typeof v === 'string' && v.toLowerCase().includes(needle)) return true
  }
  if (call.rawArguments && call.rawArguments.toLowerCase().includes(needle)) return true
  return false
}

/**
 * Handle returned by `hermes.loadSkill(...)`. Doubles as (a) a declaration that
 * the skill should be preloaded for the session, and (b) a spy target for
 * `expect(skill).toHaveBeenCalled()` (§4).
 *
 * Call records are computed lazily by scanning the owning agent's traces — but
 * only those produced *after* this handle was created. A skill can't be invoked
 * by a run that predates its load, so runs from earlier tests sharing a
 * file-scoped agent (§4) are never attributed here. Loading the skill per test
 * (a test-scoped fixture) therefore gives each test an isolated spy.
 */
export class SkillHandle {
  /** Count of the agent's traces at load time — the spy's per-test baseline. */
  private readonly since: number

  constructor(
    /** skill name as declared in SKILL.md frontmatter. */
    readonly name: string,
    /** absolute path to the skill directory on the host. */
    readonly path: string,
    /** provides the traces accumulated so far by the owning agent. */
    private readonly getTraces: () => Trace[],
  ) {
    this.since = getTraces().length
  }

  /** Detected invocations of this skill, in order, since the handle was loaded. */
  calls(): ToolCall[] {
    const detect = activeDetector()
    return this.getTraces()
      .slice(this.since)
      .flatMap((t) => detect(t, this.name))
  }

  /**
   * Every tool call observed in this handle's window, regardless of detection.
   * Used to diagnose a failing `toHaveBeenCalled`: it lets the error distinguish
   * "the skill genuinely never fired" (no calls at all) from "the skill fired
   * but the §11 heuristic didn't recognize the signal" (calls present, none
   * matched) — the latter points at {@link setSkillDetector}.
   */
  observedToolCalls(): ToolCall[] {
    return this.getTraces()
      .slice(this.since)
      .flatMap((t) => t.toolCalls)
  }
}
