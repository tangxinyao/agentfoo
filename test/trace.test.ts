import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parseTrace } from '../src/trace.js'

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
}

describe('parseTrace', () => {
  const trace = parseTrace(fixture('frontend-design-triggered.jsonl'))

  it('normalizes every role', () => {
    expect(trace.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
  })

  it('flattens tool calls with parsed arguments', () => {
    expect(trace.toolCalls).toHaveLength(1)
    expect(trace.toolCalls[0].name).toBe('skill_view')
    expect(trace.toolCalls[0].arguments).toEqual({ name: 'frontend-design' })
  })

  it('attaches the tool result back onto its call by id', () => {
    expect(trace.toolCalls[0].result).toContain('Frontend Design')
  })

  it('exposes the last assistant message as finalMessage', () => {
    expect(trace.finalMessage).toContain('落地页方案')
  })

  it('renders a transcript that includes tool calls for the judge', () => {
    const text = trace.text()
    expect(text).toContain('[user]')
    expect(text).toContain('skill_view')
  })

  // hermes' native session export carries the model's thinking in `reasoning` /
  // `reasoning_content` (identical text). Preserved because for a preloaded skill
  // it is the only evidence the skill fired (TODO §5).
  it('preserves hermes reasoning / reasoning_content, keeping it out of the transcript', () => {
    const t = parseTrace(
      JSON.stringify({
        role: 'assistant',
        content: 'Here is the page.',
        reasoning: 'Let me load the frontend-design skill first.',
        reasoning_content: 'Let me load the frontend-design skill first.',
      }),
    )
    expect(t.messages[0].reasoning).toBe('Let me load the frontend-design skill first.')
    expect(t.messages[0].content).toBe('Here is the page.')
    expect(t.text()).not.toContain('frontend-design')
  })

  it('falls back to reasoning_content when reasoning is null or blank', () => {
    const t = parseTrace(
      JSON.stringify({
        role: 'assistant',
        content: 'ok',
        reasoning: null,
        reasoning_content: 'the real thinking',
      }),
    )
    expect(t.messages[0].reasoning).toBe('the real thinking')
  })

  it('leaves reasoning undefined when the agent exports none', () => {
    const t = parseTrace(JSON.stringify({ role: 'assistant', content: 'ok' }))
    expect(t.messages[0].reasoning).toBeUndefined()
  })

  it('tolerates blank lines and non-JSON banner noise', () => {
    const noisy = 'loongsuite bootstrap started\n\n' + fixture('unrelated.jsonl')
    const t = parseTrace(noisy)
    expect(t.messages.length).toBe(5)
  })
})
