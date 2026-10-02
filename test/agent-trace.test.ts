import { describe, it, expect } from 'vitest'
import { parseOpencodePartTrace, parseAcpTrace } from '../src/trace.js'

describe('parseOpencodePartTrace', () => {
  // The real 1.18.5 envelope: a FLAT stream of one event per part, each wrapping
  // its payload in `part`, with no message objects and no `role` anywhere. The
  // test that used to live here asserted a `{role, parts:[…]}` document instead —
  // an invented shape opencode never emits — which is exactly why the parser
  // looked verified while producing an empty trace against the real thing.
  // End-to-end cover lives in trace.test.ts against a captured container run.
  it('reduces the flat part stream into assistant turns with tool calls', () => {
    const ndjson = [
      '{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}',
      '{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"bash","callID":"t1",' +
        '"state":{"status":"completed","input":{"cmd":"ls"},"output":"note.txt"}}}',
      '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"sure"}}',
      '{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","tokens":{"total":9}}}',
    ].join('\n')

    const trace = parseOpencodePartTrace(ndjson)

    expect(trace.finalMessage).toBe('sure')
    expect(trace.toolCalls).toHaveLength(1)
    expect(trace.toolCalls[0]).toMatchObject({ name: 'bash', arguments: { cmd: 'ls' } })
    // input and output arrive in the SAME event; the result is re-attached by id.
    expect(trace.toolCalls[0].result).toBe('note.txt')
  })

  it('drops step/telemetry noise rather than emitting empty turns', () => {
    const ndjson = [
      '{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}',
      '{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","cost":0.003}}',
    ].join('\n')
    expect(parseOpencodePartTrace(ndjson).messages).toHaveLength(0)
  })

  it('falls back to the OpenAI-shaped reading when no record matches the envelope', () => {
    const ndjson = '{"role":"user","content":"hi"}\n{"role":"assistant","content":"hello"}'
    const trace = parseOpencodePartTrace(ndjson)
    expect(trace.finalMessage).toBe('hello')
  })

  // The §IX.1 regression guard. The old parser expected `{role, parts:[…]}`, a
  // shape opencode never emits; every record mapped to null and the tolerant
  // fallback returned an EMPTY trace from a run that had actually succeeded, so
  // the failure surfaced as "the agent never engaged the skill". An envelope
  // nothing recognizes must be loud.
  // Simulated by renaming `part` — the wrapper key the whole mapper hangs off —
  // which is exactly what a future opencode release could do.
  it('throws (never returns an empty trace) when the envelope is unrecognizable', () => {
    const ndjson = [
      '{"type":"text","sessionID":"ses_1","event":{"type":"text","text":"hi"}}',
      '{"type":"step_finish","sessionID":"ses_1","event":{"type":"step-finish"}}',
    ].join('\n')
    expect(() => parseOpencodePartTrace(ndjson)).toThrow(/output format has probably changed/)
    // The diagnostic names the keys actually seen, so the fix is one look away.
    expect(() => parseOpencodePartTrace(ndjson)).toThrow(/type, sessionID, event/)
  })

  it('is empty for empty output', () => {
    expect(parseOpencodePartTrace('').messages).toHaveLength(0)
  })

  // A tool result closes the message that issued the call, so the transcript
  // reads assistant{tool_calls} → tool → assistant{text}. Appending every result
  // after every assistant turn (as this used to) reorders the judge-graded
  // `trace.text()` on any multi-step run.
  it('interleaves tool results with the turns that issued them', () => {
    const ndjson = [
      '{"type":"tool_use","part":{"type":"tool","tool":"glob","callID":"t1",' +
        '"state":{"status":"completed","input":{"pattern":"*"},"output":"none"}}}',
      '{"type":"text","part":{"type":"text","text":"nothing there, writing one"}}',
      '{"type":"step_finish","part":{"type":"step-finish"}}',
      '{"type":"tool_use","part":{"type":"tool","tool":"write","callID":"t2",' +
        '"state":{"status":"completed","input":{"filePath":"a.html"},"output":"ok"}}}',
      '{"type":"text","part":{"type":"text","text":"done"}}',
      '{"type":"step_finish","part":{"type":"step-finish"}}',
    ].join('\n')

    const trace = parseOpencodePartTrace(ndjson)

    expect(trace.messages.map((m) => m.role)).toEqual([
      'assistant', // glob call
      'tool', // its result
      'assistant', // "nothing there, writing one"
      'assistant', // write call
      'tool', // its result
      'assistant', // "done"
    ])
    const text = trace.text()
    expect(text.indexOf('none')).toBeLessThan(text.indexOf('nothing there'))
    expect(text.indexOf('nothing there')).toBeLessThan(text.indexOf('a.html'))
  })

  // `trace.raw` is the documented escape hatch for whatever normalization drops,
  // so it must hold the CLI's own records — not the messages we synthesized.
  it('exposes the CLI stream in trace.raw, not the synthesized messages', () => {
    const ndjson =
      '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"hi"}}'
    const trace = parseOpencodePartTrace(ndjson)
    expect(trace.raw).toEqual([
      { type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'hi' } },
    ])
  })
})

describe('parseAcpTrace', () => {
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
    const trace = parseAcpTrace(ndjson)

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
    const trace = parseAcpTrace(ndjson)
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
    const trace = parseAcpTrace(ndjson)
    expect(trace.messages).toHaveLength(1)
    expect(trace.messages[0].reasoning).toBe('thinking about frontend-design')
    expect(trace.messages[0].content).toBe('')
  })

  // ACP has no per-step marker like opencode's `step-finish`; the JSON-RPC
  // response to `session/prompt` (it carries `stopReason`) is the turn boundary.
  // Without it every chunk of a multi-turn stream collapsed into ONE assistant
  // message, so the two envelopes disagreed on what `messages.length` means.
  it('closes a turn on the session/prompt response, so turns stay separate', () => {
    const ndjson = [
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"content":{"text":"first"},"sessionUpdate":"agent_message_chunk"}}}',
      '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"content":{"text":"second"},"sessionUpdate":"agent_message_chunk"}}}',
      '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}',
    ].join('\n')
    const trace = parseAcpTrace(ndjson)
    expect(trace.messages.map((m) => m.content)).toEqual(['first', 'second'])
  })

  it('ignores update kinds it does not surface (commands / usage / resume frames)', () => {
    const noise = [
      '{"jsonrpc":"2.0","id":1,"method":"session/resume","params":{"sessionId":"s1"}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"availableCommands":[],"sessionUpdate":"available_commands_update"}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"used":10,"sessionUpdate":"usage_update"}}}',
    ].join('\n')
    expect(parseAcpTrace(noise).messages).toHaveLength(0)
  })
})
