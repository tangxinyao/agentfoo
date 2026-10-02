import { describe, expect, it } from 'vitest'
import { converse } from '../src/converse.js'
import type { Agent } from '../src/agent/types.js'
import type { Trace } from '../src/types.js'

/** An agent that asks a numbered question each turn and records what it was sent. */
function askingAgent() {
  const sent: Array<{ prompt: string; timeout?: number }> = []
  const agent = {
    async run(prompt: string, opts?: { timeout?: number }): Promise<Trace> {
      sent.push({ prompt, timeout: opts?.timeout })
      const finalMessage = `question ${sent.length}?`
      return { messages: [], toolCalls: [], raw: [], finalMessage, text: () => `[tool] SKILL.md\n${finalMessage}` }
    },
  } as unknown as Agent
  return { agent, sent }
}

describe('converse', () => {
  it('answers from a list in order, then stops', async () => {
    const { agent, sent } = askingAgent()
    const c = await converse(agent, 'help me brainstorm', ['a bakery', 'under $500'])
    expect(sent.map((s) => s.prompt)).toEqual(['help me brainstorm', 'a bakery', 'under $500'])
    expect(c.turns).toHaveLength(3)
    expect(c.stoppedBy).toBe('responder')
    expect(c.dialogue()).toBe(
      'User: help me brainstorm\n\nAgent: question 1?\n\n---\n\n' +
        'User: a bakery\n\nAgent: question 2?\n\n---\n\n' +
        'User: under $500\n\nAgent: question 3?',
    )
    expect(c.dialogue()).not.toContain('SKILL.md')
  })

  it('lets a function decide from what the agent said', async () => {
    const { agent } = askingAgent()
    const c = await converse(agent, 'start', ({ reply, index }) => (reply.endsWith('?') && index < 1 ? 'yes' : undefined))
    expect(c.userMessages).toEqual(['start', 'yes'])
  })

  it('caps a responder that never stops, and passes the per-turn timeout', async () => {
    const { agent, sent } = askingAgent()
    const c = await converse(agent, 'go', () => 'more', { maxTurns: 3, timeout: 60_000 })
    expect(c.turns).toHaveLength(3)
    expect(c.stoppedBy).toBe('maxTurns')
    expect(sent.every((s) => s.timeout === 60_000)).toBe(true)
  })
})
