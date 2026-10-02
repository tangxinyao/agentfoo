import { fileURLToPath } from 'node:url'
import { test, expect } from './fixtures'

/**
 * Forced-mode regression (TODO §P1): `loadSkill(dir, { force: true })`
 * deterministically injects the skill, skipping the model's own
 * discovery/decision step.
 *
 * First attempt at this test used the real `frontend-design` skill against an
 * unrelated weather prompt, graded by `toSatisfy` — it failed, but the
 * archived trace showed the injection had actually worked (the SKILL.md body
 * was verbatim in the sent prompt); the model just reasonably didn't apply
 * "distinctive UI design" guidance to a factual Q&A with no deliverable to
 * design. That was a flawed test, not a broken mechanism. This version proves
 * the mechanism itself with a synthetic marker skill
 * (`example/skills/forced-mode-marker`) whose one instruction is a literal,
 * checkable string — no judge call needed, no risk of a reasonable model
 * response reading as a false negative.
 */

const markerSkillDir = fileURLToPath(
  new URL('../skills/forced-mode-marker', import.meta.url),
)

test('forced skill content reaches the model even on an unrelated prompt', async ({ agent }) => {
  const skill = await agent.loadSkill(markerSkillDir, { force: true })

  const trace = await agent.run('今天北京的天气怎么样？')

  expect(trace.finalMessage).toContain('FORCED-MODE-MARKER-8f2c1a')
  // Forced-mode handles reject the discovery spy — it's meaningless here,
  // the skill was invoked by construction, not by model choice.
  expect(() => skill.calls()).toThrow(/force: true/)
})
