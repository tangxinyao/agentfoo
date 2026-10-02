import { describe, it, expect } from 'vitest'
import { buildTrace, parseOpencodePartTrace } from '../src/trace.js'
import { fixture, fixtureTrace } from './fixture-trace.js'

/**
 * Normalization, driven from a recorded capture.
 *
 * `buildTrace` is the layer every envelope ends up in: the OpenAI-shaped *message
 * record* is agentfoo's internal IR, and both stream parsers reduce their events
 * to it. So a recorded record-shaped capture is still the realistic input for
 * these assertions even though the decoder that used to read that file format off
 * disk (`parseOpenAiChatTrace`) is gone (TODO §P3) — {@link fixtureTrace} splits
 * the lines and calls `buildTrace` directly, which is all that decoder did.
 */
describe('buildTrace normalization (recorded OpenAI-record capture)', () => {
  const trace = fixtureTrace('frontend-design-triggered.jsonl')

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
  // it is the only evidence the skill fired (TODO §5). The ACP parser feeds the
  // same fields from `agent_thought_chunk`, so this stays load-bearing.
  it('preserves hermes reasoning / reasoning_content, keeping it out of the transcript', () => {
    const t = buildTrace([
      {
        role: 'assistant',
        content: 'Here is the page.',
        reasoning: 'Let me load the frontend-design skill first.',
        reasoning_content: 'Let me load the frontend-design skill first.',
      },
    ])
    expect(t.messages[0].reasoning).toBe('Let me load the frontend-design skill first.')
    expect(t.messages[0].content).toBe('Here is the page.')
    expect(t.text()).not.toContain('frontend-design')
  })

  it('falls back to reasoning_content when reasoning is null or blank', () => {
    const t = buildTrace([
      {
        role: 'assistant',
        content: 'ok',
        reasoning: null,
        reasoning_content: 'the real thinking',
      },
    ])
    expect(t.messages[0].reasoning).toBe('the real thinking')
  })

  it('leaves reasoning undefined when the agent exports none', () => {
    const t = buildTrace([{ role: 'assistant', content: 'ok' }])
    expect(t.messages[0].reasoning).toBeUndefined()
  })
})

/**
 * Pinned against a REAL opencode 1.18.5 `run --format json` capture (TODO §IX):
 * `test/fixtures/opencode-run.jsonl` is verbatim stdout from the first container
 * run of the example suite. The previous parser assumed `{role, parts:[…]}` per
 * message — a shape opencode never emits — and silently produced an empty trace
 * from a run that had actually succeeded.
 */
describe('parseOpencodePartTrace against a real 1.18.5 capture', () => {
  const capture = fixture('opencode-run.jsonl')

  it('recovers the assistant turns and every tool call', () => {
    const trace = parseOpencodePartTrace(capture)
    expect(trace.messages.length).toBeGreaterThan(0)
    expect(trace.toolCalls.map((c) => c.name)).toEqual(['glob', 'glob', 'write'])
  })

  it('keeps each tool call arguments from state.input', () => {
    const trace = parseOpencodePartTrace(capture)
    expect(trace.toolCalls[0].arguments).toEqual({ pattern: '**/*.html' })
    expect(trace.toolCalls[2].arguments).toHaveProperty('filePath')
  })

  it('attaches the tool result back onto the call by callID', () => {
    const trace = parseOpencodePartTrace(capture)
    // opencode emits input and output in one event; buildTrace re-attaches by id.
    expect(trace.toolCalls[0].result).toBe('No files found')
  })

  it('takes finalMessage from the text part', () => {
    const trace = parseOpencodePartTrace(capture)
    expect(trace.finalMessage).toContain('/workspace/index.html')
    expect(trace.text()).toContain('/workspace/index.html')
  })

  it('does not regress to the empty trace the old parser produced', () => {
    const trace = parseOpencodePartTrace(capture)
    expect(trace.messages).not.toHaveLength(0)
    expect(trace.toolCalls).not.toHaveLength(0)
  })
})
