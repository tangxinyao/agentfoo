import { describe, it, expect } from 'vitest'
import { parseOpencodeTrace, parseAcpxTrace } from '../src/trace.js'

describe('parseOpencodeTrace', () => {
  it('maps a message/parts document into a normalized trace', () => {
    const doc = JSON.stringify([
      { role: 'user', parts: [{ type: 'text', text: 'list the files' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'sure' },
          { type: 'tool', tool: 'bash', input: { cmd: 'ls' }, id: 't1' },
        ],
      },
    ])
    const trace = parseOpencodeTrace(doc)
    expect(trace.messages).toHaveLength(2)
    expect(trace.finalMessage).toBe('sure')
    expect(trace.toolCalls).toHaveLength(1)
    expect(trace.toolCalls[0]).toMatchObject({ name: 'bash', arguments: { cmd: 'ls' } })
  })

  it('falls back to buildTrace for already-OpenAI-shaped NDJSON', () => {
    const ndjson = '{"role":"user","content":"hi"}\n{"role":"assistant","content":"hello"}'
    const trace = parseOpencodeTrace(ndjson)
    expect(trace.finalMessage).toBe('hello')
  })

  it('is empty for empty output', () => {
    expect(parseOpencodeTrace('').messages).toHaveLength(0)
  })
})

describe('parseAcpxTrace', () => {
  // Real ACP JSON-RPC stream shapes captured from hermes 0.18.2 + acpx 0.12.1
  // (TODO §VI): a session/prompt echo, streamed agent_message/thought chunks, and
  // a tool_call + tool_call_update pair correlated by toolCallId.
  it('reduces the real ACP session/update stream, correlating tool results by id', () => {
    const ndjson = [
      '{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"cat note.txt"}]}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"content":{"text":"reading","type":"text"},"sessionUpdate":"agent_thought_chunk"}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"content":[{"content":{"text":"$ cat note.txt","type":"text"},"type":"content"}],"kind":"execute","title":"terminal: cat note.txt","toolCallId":"tc-1","sessionUpdate":"tool_call"}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"content":[{"content":{"text":"terminal result\\n- output: hello","type":"text"},"type":"content"}],"kind":"execute","status":"completed","toolCallId":"tc-1","sessionUpdate":"tool_call_update"}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"content":{"text":"The file says ","type":"text"},"sessionUpdate":"agent_message_chunk"}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"content":{"text":"hello.","type":"text"},"sessionUpdate":"agent_message_chunk"}}}',
      '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn","usage":{"totalTokens":10}}}',
    ].join('\n')
    const trace = parseAcpxTrace(ndjson)

    // user prompt + one assistant message (message_chunks concatenated; the
    // thought is kept out of `content` — see the reasoning test below)
    expect(trace.messages.find((m) => m.role === 'user')?.content).toBe('cat note.txt')
    expect(trace.finalMessage).toBe('The file says hello.')
    expect(trace.toolCalls).toHaveLength(1)
    expect(trace.toolCalls[0]).toMatchObject({
      name: 'execute',
      id: 'tc-1',
      result: 'terminal result\n- output: hello',
    })
    // ACP tool metadata is preserved in arguments for skill detection (§11)
    expect(trace.toolCalls[0].arguments).toMatchObject({ title: 'terminal: cat note.txt' })
  })

  // TODO §5: hermes preloads skills into its system prompt, so an activated skill
  // produces NO tool call — the model names it only in its reasoning. Dropping
  // agent_thought_chunk therefore made `toHaveBeenCalled` unsatisfiable for
  // hermes, so thoughts are kept as `reasoning` — but out of the graded text.
  it('keeps agent_thought_chunk as reasoning, excluded from content and the transcript', () => {
    const ndjson = [
      '{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"design a landing page"}]}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"content":{"text":"Let me load the frontend-design ","type":"text"},"sessionUpdate":"agent_thought_chunk"}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"content":{"text":"skill first.","type":"text"},"sessionUpdate":"agent_thought_chunk"}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"content":{"text":"Here is the page.","type":"text"},"sessionUpdate":"agent_message_chunk"}}}',
    ].join('\n')
    const trace = parseAcpxTrace(ndjson)
    const assistant = trace.messages.find((m) => m.role === 'assistant')

    // Chunks are concatenated into one reasoning string, kept off `content`.
    expect(assistant?.reasoning).toBe('Let me load the frontend-design skill first.')
    expect(assistant?.content).toBe('Here is the page.')
    expect(trace.finalMessage).toBe('Here is the page.')
    // Must not leak into the judge-graded transcript.
    expect(trace.text()).not.toContain('frontend-design')
  })

  it('emits a reasoning-only assistant turn (no message chunk, no tool call)', () => {
    const ndjson =
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"content":{"text":"thinking about frontend-design","type":"text"},"sessionUpdate":"agent_thought_chunk"}}}'
    const trace = parseAcpxTrace(ndjson)
    expect(trace.messages).toHaveLength(1)
    expect(trace.messages[0].reasoning).toBe('thinking about frontend-design')
    expect(trace.messages[0].content).toBe('')
  })

  it('ignores update kinds it does not surface (commands / usage / resume frames)', () => {
    const noise = [
      '{"jsonrpc":"2.0","id":1,"method":"session/resume","params":{"sessionId":"s1"}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"availableCommands":[],"sessionUpdate":"available_commands_update"}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"used":10,"sessionUpdate":"usage_update"}}}',
    ].join('\n')
    expect(parseAcpxTrace(noise).messages).toHaveLength(0)
  })
})
