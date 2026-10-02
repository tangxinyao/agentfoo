import type { ToolCall, Trace, TraceMessage, TraceRole } from './types.js'

/**
 * Build a normalized {@link Trace} from a hermes `sessions export --format jsonl`
 * dump (§7). hermes is built on the OpenAI SDK, so each record is an OpenAI-shaped
 * chat message; this parser is deliberately tolerant of the variants we might see
 * (content blocks vs plain strings, `tool_calls` vs legacy `function_call`, records
 * optionally wrapped in `{message: ...}` / `{messages: [...]}`) because the exact
 * shape is a §11 "verify against a real container" item.
 */
export function parseTrace(jsonl: string): Trace {
  const raw: unknown[] = []
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      raw.push(JSON.parse(trimmed))
    } catch {
      // Skip non-JSON banner lines (hermes prints an OTEL bootstrap notice).
    }
  }
  return buildTrace(raw)
}

/**
 * Parse an opencode `run --format json` dump into a normalized {@link Trace}.
 *
 * VERIFY-CLI: opencode emits JSON events for a non-interactive run, but the exact
 * envelope was not confirmable offline. This parser is deliberately tolerant —
 * it accepts a single JSON document (array, `{messages:[…]}`) or an NDJSON event
 * stream, maps recognizable opencode message/part events into OpenAI-shaped
 * records, and otherwise hands the raw records to {@link buildTrace} (which is
 * already tolerant of OpenAI-shaped input). One place to pin exactly once a real
 * opencode trace is observed.
 */
export function parseOpencodeTrace(text: string): Trace {
  const records = parseJsonStream(text)
  const mapped = records.map(mapOpencodeEvent).filter((r): r is unknown => r != null)
  return buildTrace(mapped.length ? mapped : records)
}

/**
 * Parse an acpx `--format json` (ACP NDJSON) stream into a normalized Trace.
 *
 * Pinned to the real envelope shapes captured from hermes 0.18.2 + acpx 0.12.1
 * (TODO §VI). The stream is JSON-RPC: the user prompt echoes in a `session/prompt`
 * request, and everything the agent emits arrives as `session/update`
 * notifications keyed by `params.update.sessionUpdate`:
 *   - `agent_message_chunk` — streamed assistant text (`update.content.text`),
 *     concatenated into one assistant message per turn.
 *   - `agent_thought_chunk` — reasoning; kept on the assistant message's
 *     `reasoning` field but never merged into `content`, so it stays out of
 *     `finalMessage` and the graded transcript while remaining assertable. For
 *     hermes this is the ONLY signal that a preloaded skill fired (TODO §5).
 *   - `tool_call` — `{ kind, title, toolCallId, content:[{content:{text}}] }`;
 *     mapped to an assistant `tool_calls` entry (name = `kind`, e.g. `execute`).
 *   - `tool_call_update` — the same `toolCallId` with `status` + result content;
 *     mapped to a `tool` message that {@link buildTrace} attaches back by id.
 *   - `available_commands_update` / `usage_update` / resume+result frames — noise.
 *
 * VERIFY-CLI: the assistant/thought/tool shapes are confirmed for hermes' ACP
 * adapter; other acpx agents (pi/openclaw) may label `kind`/`title` differently.
 */
export function parseAcpxTrace(text: string): Trace {
  const records = parseJsonStream(text)
  const synth: unknown[] = []
  let assistantText = ''
  let thoughtText = ''
  let toolCalls: unknown[] = []
  const toolResults: unknown[] = []

  const flushAssistant = () => {
    if (!assistantText.trim() && toolCalls.length === 0 && !thoughtText.trim()) return
    const msg: Record<string, unknown> = { role: 'assistant', content: assistantText }
    if (toolCalls.length) msg.tool_calls = toolCalls
    // Thoughts are kept as `reasoning` (never merged into `content`, so they stay
    // out of the graded transcript) — for hermes this is the only skill-firing
    // signal there is (TODO §5).
    if (thoughtText.trim()) msg.reasoning = thoughtText
    synth.push(msg)
    assistantText = ''
    thoughtText = ''
    toolCalls = []
  }

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    const obj = rec as Record<string, unknown>
    const params = obj.params as Record<string, unknown> | undefined

    if (obj.method === 'session/prompt') {
      const promptText = acpText((params?.prompt as unknown) ?? undefined)
      if (promptText.trim()) synth.push({ role: 'user', content: promptText })
      continue
    }
    if (obj.method !== 'session/update') continue
    const update = params?.update as Record<string, unknown> | undefined
    if (!update) continue

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        assistantText += acpText(update.content)
        break
      case 'agent_thought_chunk':
        thoughtText += acpText(update.content)
        break
      case 'tool_call':
        toolCalls.push({
          id: typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
          function: {
            name: acpToolName(update),
            arguments: {
              title: update.title,
              kind: update.kind,
              text: acpText(update.content),
            },
          },
        })
        break
      case 'tool_call_update':
        toolResults.push({
          role: 'tool',
          tool_call_id: typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
          content: acpText(update.content),
        })
        break
      // available_commands_update, usage_update: ignored. (The former advertises
      // the agent's slash/skill commands — capture it when forced skill
      // invocation lands, TODO §8.)
    }
  }

  flushAssistant()
  for (const r of toolResults) synth.push(r)
  return buildTrace(synth.length ? synth : records)
}

/**
 * Flatten ACP `content` into text. It appears as `{text}`, a `{content:{text}}`
 * wrapper, or an array of either (tool_call content is
 * `[{content:{text},type:'content'}]`; a prompt is `[{type:'text',text}]`).
 */
function acpText(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(acpText).join('')
  if (typeof content === 'object') {
    const c = content as Record<string, unknown>
    if (typeof c.text === 'string') return c.text
    if (c.content != null) return acpText(c.content)
  }
  return ''
}

/** Tool name for an ACP tool_call: the machine `kind` (e.g. `execute`), else the title's head. */
function acpToolName(update: Record<string, unknown>): string {
  if (typeof update.kind === 'string' && update.kind) return update.kind
  if (typeof update.title === 'string' && update.title) return update.title.split(':')[0].trim()
  return 'tool'
}

/** Parse either a single JSON document (array/object) or an NDJSON stream. */
function parseJsonStream(text: string): unknown[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  // Try the whole payload as one JSON document first.
  try {
    const doc = JSON.parse(trimmed)
    return Array.isArray(doc) ? doc : [doc]
  } catch {
    /* fall through to line-by-line NDJSON */
  }
  const out: unknown[] = []
  for (const line of trimmed.split('\n')) {
    const l = line.trim()
    if (!l) continue
    try {
      out.push(JSON.parse(l))
    } catch {
      /* skip non-JSON banner lines */
    }
  }
  return out
}

/**
 * Map one opencode event to an OpenAI-shaped message record, or null to defer to
 * buildTrace's own tolerance. Recognizes a `{role, parts:[…]}` message where
 * parts are `{type:'text',text}` / `{type:'tool',tool,input,output,id}`.
 */
function mapOpencodeEvent(rec: unknown): unknown {
  if (!rec || typeof rec !== 'object') return null
  const obj = rec as Record<string, unknown>
  const parts = obj.parts
  if (typeof obj.role !== 'string' || !Array.isArray(parts)) return null

  const textChunks: string[] = []
  const toolCalls: unknown[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (p.type === 'text' && typeof p.text === 'string') textChunks.push(p.text)
    else if (p.type === 'tool' || p.type === 'tool_call' || typeof p.tool === 'string') {
      toolCalls.push({
        id: typeof p.id === 'string' ? p.id : undefined,
        function: { name: p.tool ?? p.name, arguments: p.input ?? p.arguments ?? {} },
      })
    }
  }
  const out: Record<string, unknown> = { role: obj.role, content: textChunks.join('\n') }
  if (toolCalls.length) out.tool_calls = toolCalls
  return out
}

/** Build a Trace from already-parsed records (used by tests with recorded data). */
export function buildTrace(raw: unknown[]): Trace {
  const records = raw.flatMap(expandRecord)
  const messages: TraceMessage[] = []
  for (const rec of records) {
    const msg = toMessage(rec)
    if (msg) messages.push(msg)
  }

  const toolCalls: ToolCall[] = messages.flatMap((m) => m.toolCalls ?? [])

  // Attach tool results back onto the originating call by id.
  const resultsById = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) resultsById.set(m.toolCallId, m.content)
  }
  for (const call of toolCalls) {
    if (call.id && resultsById.has(call.id)) call.result = resultsById.get(call.id)
  }

  const finalMessage =
    [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content ?? ''

  return {
    messages,
    toolCalls,
    finalMessage,
    raw,
    text: () => renderTranscript(messages),
  }
}

function expandRecord(rec: unknown): unknown[] {
  if (rec && typeof rec === 'object') {
    const obj = rec as Record<string, unknown>
    if (Array.isArray(obj.messages)) return obj.messages
    if (obj.message && typeof obj.message === 'object') return [obj.message]
  }
  return [rec]
}

function toMessage(rec: unknown): TraceMessage | null {
  if (!rec || typeof rec !== 'object') return null
  const obj = rec as Record<string, unknown>
  const role = normalizeRole(obj.role)
  if (!role) return null

  const content = extractContent(obj.content)
  const toolCalls = extractToolCalls(obj)

  const msg: TraceMessage = { role, content }
  if (toolCalls.length) msg.toolCalls = toolCalls
  if (typeof obj.tool_call_id === 'string') msg.toolCallId = obj.tool_call_id
  if (typeof obj.name === 'string' && role === 'tool') msg.toolName = obj.name
  // hermes exports both `reasoning` and `reasoning_content` (same text); ACP's
  // synthesized records use `reasoning`. First non-empty wins.
  const reasoning = [obj.reasoning, obj.reasoning_content].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  )
  if (reasoning) msg.reasoning = reasoning
  return msg
}

function normalizeRole(role: unknown): TraceRole | null {
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') return role
  if (role === 'function') return 'tool'
  return null
}

/** hermes content can be a plain string or an array of typed blocks. */
function extractContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>
          if (typeof b.text === 'string') return b.text
          if (typeof b.content === 'string') return b.content
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function extractToolCalls(obj: Record<string, unknown>): ToolCall[] {
  const out: ToolCall[] = []

  if (Array.isArray(obj.tool_calls)) {
    for (const tc of obj.tool_calls) {
      const call = parseOpenAiToolCall(tc)
      if (call) out.push(call)
    }
  }

  // Legacy single function_call shape.
  if (obj.function_call && typeof obj.function_call === 'object') {
    const fc = obj.function_call as Record<string, unknown>
    if (typeof fc.name === 'string') {
      out.push(makeCall(fc.name, fc.arguments))
    }
  }

  return out
}

function parseOpenAiToolCall(tc: unknown): ToolCall | null {
  if (!tc || typeof tc !== 'object') return null
  const obj = tc as Record<string, unknown>
  const fn = (obj.function ?? obj) as Record<string, unknown>
  const name = typeof fn.name === 'string' ? fn.name : undefined
  if (!name) return null
  const call = makeCall(name, fn.arguments)
  if (typeof obj.id === 'string') call.id = obj.id
  return call
}

function makeCall(name: string, rawArgs: unknown): ToolCall {
  let args: Record<string, unknown> = {}
  let rawArguments: string | undefined
  if (typeof rawArgs === 'string') {
    rawArguments = rawArgs
    try {
      const parsed = JSON.parse(rawArgs)
      if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
    } catch {
      /* leave args empty, keep raw */
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs as Record<string, unknown>
    rawArguments = JSON.stringify(rawArgs)
  }
  return { name, arguments: args, rawArguments }
}

function renderTranscript(messages: TraceMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    let block = `[${m.role}]`
    if (m.content.trim()) block += `\n${m.content.trim()}`
    if (m.toolCalls?.length) {
      for (const call of m.toolCalls) {
        block += `\n<tool_call name="${call.name}">${call.rawArguments ?? ''}</tool_call>`
        if (call.result) block += `\n<tool_result>${call.result}</tool_result>`
      }
    }
    parts.push(block)
  }
  return parts.join('\n\n')
}
