import type { ToolCall, Trace, TraceMessage, TraceRole } from './types.js'

/**
 * Trace parsers, one per **wire envelope** — not one per agent. Four built-in
 * agents map onto three envelopes (hermes/pi/openclaw all speak ACP through
 * acpx), and a bring-your-own CLI may reuse any of them, so these are named
 * after the format they decode:
 *
 * | parser                    | envelope                            | agents            |
 * |---------------------------|-------------------------------------|-------------------|
 * | {@link parseOpenAiChatTrace}  | OpenAI chat jsonl, one msg/record   | BYO default (§7)  |
 * | {@link parseOpencodePartTrace}| opencode `run --format json` parts  | opencode          |
 * | {@link parseAcpTrace}         | ACP JSON-RPC `session/update` stream| hermes, pi, openclaw |
 *
 * They are deliberately NOT one auto-sniffing `parseTrace`: the three are
 * different protocols (records with `role` / flat part events with no role /
 * JSON-RPC notifications that split a tool call from its result), and every
 * added sniffing branch is another way to mis-detect and silently produce an
 * empty trace — the §IX.1 failure mode. What they DO share is the streaming
 * shape, and that is factored out into {@link reduceEventStream} below: each
 * stream parser is just an envelope→{@link StreamEvent} mapper.
 */

/**
 * Build a normalized {@link Trace} from OpenAI-shaped chat jsonl — one record per
 * message, each carrying its own `role`. This is the default parser for a custom
 * {@link file://./agent/command.ts CommandAgentDef} and the shape hermes' native
 * `sessions export --format jsonl` emits (hermes itself now runs over ACP, see
 * {@link parseAcpTrace}).
 *
 * Deliberately tolerant of the variants an OpenAI-SDK-based CLI might produce:
 * content blocks vs plain strings, `tool_calls` vs legacy `function_call`, and
 * records optionally wrapped in `{message: …}` / `{messages: […]}`.
 */
export function parseOpenAiChatTrace(jsonl: string): Trace {
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

// ---------------------------------------------------------------------------
// Shared streaming layer
// ---------------------------------------------------------------------------

/**
 * One normalized event from a streaming agent CLI — the vocabulary every stream
 * envelope reduces to. `content`/`arguments` stay `unknown` so a payload that is
 * not a plain string (a content-block array, a structured tool output) reaches
 * {@link buildTrace}'s own flatteners intact.
 */
type StreamEvent =
  | { type: 'user'; text: string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id?: string; name: string; arguments: unknown }
  | { type: 'tool-result'; id?: string; content: unknown }
  | { type: 'turn-end' }

/**
 * Map one raw stream record to normalized events.
 *
 * - `null` — this record is **not recognized at all**. A stream in which nothing
 *   is recognized is how an envelope change announces itself, and
 *   {@link parseEventStream} turns that into a loud error instead of an empty
 *   trace.
 * - `[]` — recognized, but carries no conversation (telemetry, turn scaffolding,
 *   protocol frames we deliberately drop).
 */
type StreamMapper = (record: Record<string, unknown>) => StreamEvent[] | null

/**
 * Fold a stream of {@link StreamEvent}s into OpenAI-shaped message records, which
 * {@link buildTrace} then normalizes. Text and reasoning accumulate into a pending
 * assistant message that is flushed at a turn boundary — or as soon as a tool
 * *result* arrives, so the emitted order interleaves the way an OpenAI transcript
 * does (`assistant{tool_calls}` → `tool` → `assistant{text}`) rather than
 * stacking every tool result at the end, which would misrepresent the ordering in
 * the judge-graded `trace.text()`.
 */
function reduceEventStream(
  records: unknown[],
  map: StreamMapper,
): { synth: unknown[]; recognized: number } {
  const synth: unknown[] = []
  let recognized = 0
  let text = ''
  let reasoning = ''
  let toolCalls: unknown[] = []

  const flush = () => {
    if (!text.trim() && !reasoning.trim() && toolCalls.length === 0) return
    const msg: Record<string, unknown> = { role: 'assistant', content: text }
    if (toolCalls.length) msg.tool_calls = toolCalls
    // Reasoning is a first-class field, never merged into `content`, so it stays
    // out of `finalMessage` and the graded transcript while remaining assertable.
    // For a preloaded skill it is the only firing signal there is (TODO §5).
    if (reasoning.trim()) msg.reasoning = reasoning
    synth.push(msg)
    text = ''
    reasoning = ''
    toolCalls = []
  }

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    const events = map(rec as Record<string, unknown>)
    if (!events) continue
    recognized++
    for (const ev of events) {
      switch (ev.type) {
        case 'user':
          flush()
          synth.push({ role: 'user', content: ev.text })
          break
        case 'text':
          text += ev.text
          break
        case 'reasoning':
          reasoning += ev.text
          break
        case 'tool-call':
          toolCalls.push({
            id: ev.id,
            function: { name: ev.name, arguments: ev.arguments ?? {} },
          })
          break
        case 'tool-result':
          flush()
          synth.push({ role: 'tool', tool_call_id: ev.id, content: ev.content })
          break
        case 'turn-end':
          flush()
          break
      }
    }
  }

  flush()
  return { synth, recognized }
}

/**
 * Decode a stream (NDJSON or a single JSON document) through a
 * {@link StreamMapper}.
 *
 * When *no* record matches the envelope the stream is retried as plain
 * OpenAI-shaped records — some CLIs emit that directly — and if that finds
 * nothing either, this **throws** naming the envelope. That case used to fall
 * through silently: §IX.1's parser was written for a shape opencode never emits,
 * so an 81-second successful run reported `0 messages, 0 tool calls` and the
 * failure surfaced as "the agent never engaged the skill", blaming the agent for
 * a parser bug. A partially-recognized stream never falls back — a real stream
 * legitimately contains records that carry no conversation.
 */
function parseEventStream(text: string, map: StreamMapper, envelope: string): Trace {
  const records = parseJsonStream(text)
  const { synth, recognized } = reduceEventStream(records, map)
  if (recognized > 0) return buildTraceFrom(synth, records)

  const fallback = buildTrace(records)
  if (fallback.messages.length > 0 || records.length === 0) return fallback
  throw new Error(
    `${envelope}: none of the ${records.length} records in the stream matched the expected ` +
      'envelope, and they are not OpenAI-shaped messages either — the CLI output format has ' +
      `probably changed. First record keys: ${describeKeys(records[0])}`,
  )
}

/** Key names of a sample record, to make an envelope mismatch diagnosable. */
function describeKeys(rec: unknown): string {
  if (!rec || typeof rec !== 'object') return typeof rec
  return Object.keys(rec as Record<string, unknown>).join(', ') || '(none)'
}

// ---------------------------------------------------------------------------
// opencode: `run --format json`
// ---------------------------------------------------------------------------

/**
 * Map one opencode part event. Pinned to the real envelope captured from opencode
 * 1.18.5 (TODO §IX) — an NDJSON stream of **one event per part**, flat, with no
 * message objects and no `role` anywhere:
 *
 * ```
 * {"type":"step_start","timestamp":…,"sessionID":"ses_…","part":{…,"type":"step-start"}}
 * {"type":"tool_use", …,"part":{"type":"tool","tool":"glob","callID":"call_…",
 *                               "state":{"status":"completed","input":{…},"output":"…"}}}
 * {"type":"text",     …,"part":{"type":"text","text":"已完成。…"}}
 * {"type":"step_finish", …,"part":{…,"tokens":{…},"cost":…}}
 * ```
 *
 * Note a tool's input and output arrive in the **same** event, unlike ACP's
 * `tool_call` + `tool_call_update` pair; the result is still emitted as a
 * separate event so {@link buildTrace} re-attaches it by id. `step-finish` is the
 * turn boundary (its token/cost telemetry is dropped); `step-start` is noise.
 *
 * Unlike ACP there is no user-prompt echo in the stream, so a trace holds only
 * the agent side of the turn.
 */
const opencodePartMapper: StreamMapper = (rec) => {
  const part = rec.part as Record<string, unknown> | undefined
  if (!part || typeof part !== 'object') return null

  if (part.type === 'text') {
    return typeof part.text === 'string' ? [{ type: 'text', text: part.text }] : []
  }
  if (part.type === 'step-finish') return [{ type: 'turn-end' }]
  if (part.type !== 'tool') return []

  const state = (part.state ?? {}) as Record<string, unknown>
  const id = typeof part.callID === 'string' ? part.callID : undefined
  const events: StreamEvent[] = [
    {
      type: 'tool-call',
      id,
      name: typeof part.tool === 'string' ? part.tool : 'tool',
      arguments: state.input ?? {},
    },
  ]
  if (id && state.output != null) events.push({ type: 'tool-result', id, content: state.output })
  return events
}

/** Parse an opencode `run --format json` stream into a normalized {@link Trace}. */
export function parseOpencodePartTrace(text: string): Trace {
  return parseEventStream(text, opencodePartMapper, 'opencode run --format json')
}

// ---------------------------------------------------------------------------
// ACP (acpx `--format json`)
// ---------------------------------------------------------------------------

/**
 * Map one ACP JSON-RPC frame. Pinned to the real shapes captured from hermes
 * 0.18.2 + acpx 0.12.1 (TODO §VI): the user prompt echoes in a `session/prompt`
 * request and everything the agent emits arrives as `session/update`
 * notifications keyed by `params.update.sessionUpdate`:
 *   - `agent_message_chunk` — streamed assistant text (`update.content.text`).
 *   - `agent_thought_chunk` — reasoning; kept off `content` (see
 *     {@link reduceEventStream}). For hermes this is the ONLY signal that a
 *     preloaded skill fired (TODO §5).
 *   - `tool_call` — `{ kind, title, toolCallId, content:[{content:{text}}] }`;
 *     name = `kind` (e.g. `execute`), with title/kind kept in `arguments` for
 *     skill detection.
 *   - `tool_call_update` — the same `toolCallId` with `status` + result content.
 *   - `available_commands_update` / `usage_update` / resume frames — noise.
 *
 * The JSON-RPC *response* to `session/prompt` (it carries `stopReason`) is the
 * turn boundary — ACP has no per-step marker like opencode's `step-finish`.
 *
 * VERIFY-CLI: the assistant/thought/tool shapes are confirmed for hermes' ACP
 * adapter; other acpx agents (pi/openclaw) may label `kind`/`title` differently.
 */
const acpMapper: StreamMapper = (rec) => {
  // Anything JSON-RPC is recognized, even if we surface nothing from it.
  if (!rec.jsonrpc && typeof rec.method !== 'string') return null
  const params = rec.params as Record<string, unknown> | undefined

  if (rec.method === 'session/prompt') {
    const promptText = acpText(params?.prompt)
    return promptText.trim() ? [{ type: 'user', text: promptText }] : []
  }
  if (rec.method !== 'session/update') {
    const result = rec.result as Record<string, unknown> | undefined
    if (result && typeof result === 'object' && 'stopReason' in result) return [{ type: 'turn-end' }]
    return []
  }

  const update = params?.update as Record<string, unknown> | undefined
  if (!update) return []
  const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return [{ type: 'text', text: acpText(update.content) }]
    case 'agent_thought_chunk':
      return [{ type: 'reasoning', text: acpText(update.content) }]
    case 'tool_call':
      return [
        {
          type: 'tool-call',
          id,
          name: acpToolName(update),
          arguments: { title: update.title, kind: update.kind, text: acpText(update.content) },
        },
      ]
    case 'tool_call_update':
      return [{ type: 'tool-result', id, content: acpText(update.content) }]
    default:
      // available_commands_update, usage_update: ignored. (The former advertises
      // the agent's slash/skill commands — capture it when forced skill
      // invocation lands, TODO §8.)
      return []
  }
}

/** Parse an acpx `--format json` (ACP NDJSON) stream into a normalized {@link Trace}. */
export function parseAcpTrace(text: string): Trace {
  return parseEventStream(text, acpMapper, 'acpx --format json (ACP)')
}

// ---------------------------------------------------------------------------
// Deprecated aliases (pre-0.2 names)
// ---------------------------------------------------------------------------

/** @deprecated Renamed to {@link parseOpenAiChatTrace} — it decodes a format, not "the" trace. */
export const parseTrace = parseOpenAiChatTrace
/** @deprecated Renamed to {@link parseOpencodePartTrace}. */
export const parseOpencodeTrace = parseOpencodePartTrace
/** @deprecated Renamed to {@link parseAcpTrace} — acpx is the launcher, ACP is the protocol. */
export const parseAcpxTrace = parseAcpTrace

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

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

/** Build a Trace from already-parsed records (used by tests with recorded data). */
export function buildTrace(raw: unknown[]): Trace {
  return buildTraceFrom(raw, raw)
}

/**
 * Normalize `records` into a {@link Trace} while exposing `raw` untouched.
 * The two differ for the stream parsers: they normalize *synthesized* messages,
 * but `trace.raw` must stay the CLI's own records so the escape hatch can reach
 * anything this layer drops.
 */
function buildTraceFrom(records: unknown[], raw: unknown[]): Trace {
  const expanded = records.flatMap(expandRecord)
  const messages: TraceMessage[] = []
  for (const rec of expanded) {
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
  // hermes exports both `reasoning` and `reasoning_content` (same text); the
  // stream parsers synthesize `reasoning`. First non-empty wins.
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

/** Message content can be a plain string or an array of typed blocks. */
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
