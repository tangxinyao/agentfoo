import { randomUUID } from 'node:crypto'
import { describe } from 'vitest'
import { test, expect } from './fixtures'

/**
 * Live regression for TODO §P0: hermes' cross-session `session_search` tool read
 * back a secret seeded in an earlier test, because ACP `sessions new` isolates
 * the conversation but not hermes' session DB. `isolatePerTest` gives each test
 * its own `--cwd` + HERMES_HOME; this proves it end to end.
 *
 * hermes-only (it is about hermes' session DB): runs under `-a hermes`, skipped
 * otherwise. Tests in a file run in order and share the file-scoped agent.
 */

const seed = `AGENTFOO-SEED-${randomUUID().slice(0, 8)}`

describe.runIf(process.env.AGENTFOO_AGENT === 'hermes')('hermes session isolation (TODO §P0)', () => {
  test('test A: plant a secret in this session', async ({ agent }) => {
    const trace = await agent.run(`请记住这个暗号：${seed}。之后可能会问你。只回复“好的”。`)
    expect(trace.finalMessage.length).toBeGreaterThan(0)
  })

  test('test B: session search must not find it', async ({ agent }) => {
    const trace = await agent.run(
      '请调用你的 session search 工具，搜索你过去所有会话里出现过的、以 AGENTFOO-SEED 开头的暗号。' +
        '找到就原样输出完整暗号；找不到就只回答 NOT FOUND。',
    )
    // A negative is only evidence if the tool actually ran.
    const searched = trace.toolCalls.some((c) => /session/i.test(`${c.name} ${c.rawArguments ?? ''}`))
    expect(searched, `hermes never called session search; tool calls: ${trace.toolCalls.map((c) => c.name).join(', ') || 'none'}`).toBe(true)
    expect(trace.text()).not.toContain(seed)
  })
})
