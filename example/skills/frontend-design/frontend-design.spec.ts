import { test, expect } from '../../test/fixtures'

/**
 * Skill tests for Anthropic's `frontend-design` skill on hermes-agent.
 *
 * These are live tests: each `hermes.run(...)` boots hermes (local runtime here)
 * and does a real model round-trip, so they require an LLM API key. Run with:
 *   agentfoo run --local
 */

test('triggers on a UI design request', async ({ hermes, frontendDesign }) => {
  const trace = await hermes.run(
    '帮我为一个精品手冲咖啡品牌做一个产品落地页的视觉设计，要有格调、不要模板感。',
  )

  // The skill should have been pulled in to guide the design work (§5 spy).
  expect(frontendDesign).toHaveBeenCalled()

  // And the output should reflect the skill's core guidance (§5 rubric).
  // toSatisfy is async — it calls the judge model — so it must be awaited.
  await expect(trace).toSatisfy(
    [
      { criteria: '做出了具体、有意图的排版/配色/布局选择，而不是套用模板默认值', weight: 2 },
      { criteria: '设计选择与"精品手冲咖啡"这一主题内容相关联', weight: 2 },
      { criteria: '提到了可访问性或响应式等落地细节', weight: 1 },
    ],
    { threshold: 0.7 },
  )
})

test('does not trigger on an unrelated request', async ({ hermes, frontendDesign }) => {
  await hermes.run('今天北京的天气怎么样？')
  expect(frontendDesign).not.toHaveBeenCalled()
})
