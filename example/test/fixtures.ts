import { fileURLToPath } from 'node:url'
import { test as base, bootAgent } from 'agentfoo'
import type { HermesAgent, SkillHandle } from 'agentfoo'

/**
 * Project-level shared fixtures (§4). The vitest `test.extend()` mechanism does
 * setup/teardown, lifecycle scoping, and lazy dependency resolution for us.
 */

const frontendDesignDir = fileURLToPath(
  new URL('../skills/frontend-design', import.meta.url),
)

interface Fixtures {
  hermes: HermesAgent
  frontendDesign: SkillHandle
}

export const test = base.extend<Fixtures>({
  // `scope: 'file'` → one hermes container per spec file, torn down when the
  // file finishes. Note (§4): workspace state persists across `it`s in a file.
  hermes: [
    async ({}, use) => {
      const agent = await bootAgent('hermes')
      await use(agent)
      await agent.teardown()
    },
    { scope: 'file' },
  ],

  // The returned handle is both the "load this skill" declaration and the spy
  // target for `toHaveBeenCalled` (§4).
  frontendDesign: async ({ hermes }, use) => {
    await use(await hermes.loadSkill(frontendDesignDir))
  },
})

export { expect } from 'agentfoo'
