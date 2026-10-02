import { fileURLToPath } from 'node:url'
import { test as base, bootAgent, setSkillDetector } from 'agentfoo'
import type { Agent, SkillHandle, ToolCall, Trace } from 'agentfoo'

/**
 * Project-level shared fixtures (§4). The vitest `test.extend()` mechanism does
 * setup/teardown, lifecycle scoping, and lazy dependency resolution for us.
 */

/**
 * Pin the §11 skill-invocation signal to what hermes' real traces actually show.
 *
 * The built-in `detectSkillInvocations` heuristic looks for a `skill_*` tool
 * call — but hermes *preloads* skills into its system prompt, so activating one
 * is NOT a tool call. Observed against a real DeepSeek run: the only tool call on
 * a design turn is `write_file`; the genuine signal that the preloaded skill drove
 * the turn is the model naming it in its reasoning ("load the frontend-design
 * skill…", "avoids the defaults the frontend-design skill mentions"). The
 * unrelated (weather) turn never names it. So we treat a by-name reference in a
 * turn's reasoning as the invocation and surface it as a synthetic marker call,
 * which is what `toHaveBeenCalled` counts.
 *
 * Reasoning reaches us via `TraceMessage.reasoning`, which both parsers populate
 * (hermes `reasoning`/`reasoning_content`; ACP `agent_thought_chunk`).
 *
 * This runs inside each vitest worker (registered from a `setupFiles` module).
 *
 * ⚠ This detector is hermes-shaped. `setSkillDetector` is a single per-worker slot,
 * so running these specs against another agent via `-a` will grade them with the
 * wrong signal — opencode fires a real `skill({name})` tool call and never names
 * the skill in reasoning, so `toHaveBeenCalled` would go silently false. Making
 * detection per-agent is TODO §5; do it before adding a second agent here.
 */
setSkillDetector((trace: Trace, skillName: string): ToolCall[] => {
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
})

const frontendDesignDir = fileURLToPath(
  new URL('../skills/frontend-design', import.meta.url),
)

interface Fixtures {
  agent: Agent
  frontendDesign: SkillHandle
}

export const test = base.extend<Fixtures>({
  // `bootAgent()` with no kind takes the agent from `-a/--agent`, falling back to
  // the sole agent in agentfoo.config.ts — so `agentfoo run -a opencode` retargets
  // these specs without touching them.
  //
  // `scope: 'file'` → one container per spec file, torn down when the file
  // finishes. Note (§4): workspace state persists across `it`s in a file.
  agent: [
    async ({}, use) => {
      const agent = await bootAgent()
      await use(agent)
      await agent.teardown()
    },
    { scope: 'file' },
  ],

  // The returned handle is both the "load this skill" declaration and the spy
  // target for `toHaveBeenCalled` (§4).
  frontendDesign: async ({ agent }, use) => {
    await use(await agent.loadSkill(frontendDesignDir))
  },
})

export { expect } from 'agentfoo'
