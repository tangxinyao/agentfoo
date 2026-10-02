import type { ToolCall, Trace } from './types.js'

/**
 * A skill-invocation detector: given a trace and the skill name, return the
 * tool calls that represent that skill firing. See {@link setSkillDetector}.
 */
export type SkillDetector = (trace: Trace, skillName: string) => ToolCall[]

let customDetector: SkillDetector | undefined

/**
 * Override the skill-invocation heuristic (§11) for the whole worker. Because
 * the "which tool_call means a skill fired" signal is agent- and
 * version-specific, a suite that has observed its own agent's real traces can
 * pin the signal exactly. Call this from a `setupFiles` module (it runs inside
 * each worker):
 *
 * ```ts
 * import { setSkillDetector } from 'agentfoo'
 * setSkillDetector((trace, name) =>
 *   trace.toolCalls.filter((c) => c.name === 'skill_view' && c.arguments.name === name))
 * ```
 *
 * ⚠ This slot is per-worker GLOBAL, so it applies to *every* agent the worker
 * boots. Since the signal differs per agent (§8.1) — opencode fires a real
 * `skill({name})` tool call, hermes only names the skill in its reasoning — an
 * override set here will grade a second agent with the first one's signal. Most
 * suites should not need it: each adapter now ships its own default detector
 * ({@link SkillHandle}), which is what runs when this is unset. Reach for it only
 * to fix a signal agentfoo gets wrong, and prefer a union detector (match the
 * tool call *and* scan reasoning) over an agent-shaped one.
 *
 * Pass `undefined` to restore per-agent defaults.
 */
export function setSkillDetector(fn: SkillDetector | undefined): void {
  customDetector = fn
}

/**
 * Resolve the detector for one skill handle, most specific override first:
 * the global {@link setSkillDetector} slot, then the owning adapter's own
 * default, then the built-in guess.
 */
export function activeDetector(agentDetector?: SkillDetector): SkillDetector {
  return customDetector ?? agentDetector ?? detectSkillInvocations
}

/**
 * Detector for agents that **preload** skills into the system prompt, where
 * activating one is not a tool call at all: hermes is the verified case (§5).
 * The genuine signal there is the model naming the skill in its reasoning
 * ("load the frontend-design skill…"), so a by-name reference in a turn's
 * `reasoning` (or, failing that, its visible content) counts as one invocation
 * and is surfaced as a synthetic `skill:<name>` marker call — which is what
 * `toHaveBeenCalled` counts.
 *
 * Verified against real traces from both hermes paths — the recorded native
 * `sessions export` run and the ACP/acpx stream — because reasoning is a
 * first-class {@link TraceMessage.reasoning} field that both parsers populate
 * (hermes `reasoning`/`reasoning_content`; ACP `agent_thought_chunk`). The
 * negative case discriminates: an unrelated turn never names the skill.
 */
export const reasoningReferenceDetector: SkillDetector = (trace, skillName) => {
  const needle = skillName.toLowerCase()
  const calls: ToolCall[] = []
  for (const msg of trace.messages) {
    const evidence = [msg.reasoning, msg.content]
      .filter((s): s is string => typeof s === 'string')
      .find((s) => s.toLowerCase().includes(needle))
    if (evidence) {
      calls.push({
        name: `skill:${skillName}`,
        arguments: { via: 'reasoning-reference', name: skillName },
        result: evidence.slice(0, 200),
      })
    }
  }
  return calls
}

/**
 * Detector for agents that advertise skills as **descriptions plus a path** and
 * expect the model to open the file when a task matches — pi is the verified
 * case (§5). There is no skill tool: pi injects `<skill name= location=>` into
 * the system prompt, so the firing signal is an ordinary `read` of that
 * location, which is the row the signal matrix predicted and a real trace
 * confirmed.
 *
 * Two independent pieces of evidence count, because which one is present depends
 * on how much of the tool frame the agent fills in:
 *  - **the path** — a tool input naming `<skill>/SKILL.md` (pi streams this into
 *    `rawInput`/`locations`, captured by `parseAcpTrace`); or
 *  - **the payload** — a tool result whose frontmatter is this skill's, i.e. a
 *    `name: <skill>` line, which is how the SKILL.md text arrives back.
 *
 * Both are specific to *this* skill's file, so the negative case still
 * discriminates: an unrelated turn neither reads that path nor gets that
 * frontmatter back. A bare mention of the skill's name in prose is deliberately
 * NOT evidence here — pi's system prompt already lists every skill by name, so
 * treating a mention as a firing would make the positive case near-unfalsifiable.
 */
export const skillFileReadDetector: SkillDetector = (trace, skillName) => {
  const needle = skillName.toLowerCase()
  // `name: <skill>` as its own frontmatter line, not merely the string somewhere.
  const frontmatter = new RegExp(`(^|\\n)\\s*name:\\s*${escapeRegExp(needle)}\\s*(\\n|$)`)
  return trace.toolCalls.filter((call) => {
    const input = JSON.stringify(call.arguments ?? {}).toLowerCase()
    if (input.includes(`${needle}/skill.md`)) return true
    return typeof call.result === 'string' && frontmatter.test(call.result.toLowerCase())
  })
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
    /**
     * The owning adapter's default detector, used unless a suite has overridden
     * detection globally with {@link setSkillDetector}. Adapters pass this so a
     * suite that boots two agents grades each with its own signal (§5) —
     * detection cannot be one global guess, because the signal is per-agent
     * (§8.1). Omit to fall back to {@link detectSkillInvocations}.
     */
    private readonly agentDetector?: SkillDetector,
  ) {
    this.since = getTraces().length
  }

  /** Detected invocations of this skill, in order, since the handle was loaded. */
  calls(): ToolCall[] {
    const detect = activeDetector(this.agentDetector)
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
