import { fileURLToPath } from 'node:url'
import { test as base, bootAgent } from 'agentfoo'
import type { Agent, SkillHandle } from 'agentfoo'

/**
 * Project-level shared fixtures (§4). The vitest `test.extend()` mechanism does
 * setup/teardown, lifecycle scoping, and lazy dependency resolution for us.
 *
 * No `setSkillDetector` here on purpose. These specs used to pin hermes' signal
 * globally — hermes preloads skills into its system prompt, so a firing is not a
 * tool call, only a by-name mention in the model's reasoning. That override is
 * now the hermes adapter's own default (`reasoningReferenceDetector`), because
 * `setSkillDetector` is a single per-worker slot: running the same specs against
 * another agent via `-a` would have graded them with hermes' signal, and
 * opencode's real `skill({name})` tool call would have gone silently undetected
 * (TODO §5).
 */

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
