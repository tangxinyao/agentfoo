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

  it('tolerates blank lines and non-JSON banner noise', () => {
    const noisy = 'loongsuite bootstrap started\n\n' + fixture('unrelated.jsonl')
    const t = parseTrace(noisy)
    expect(t.messages.length).toBe(5)
  })
})
