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
