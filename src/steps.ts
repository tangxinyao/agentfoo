/**
 * Per-turn step timeline (§9 artifacts).
 *
 * A 37-minute turn used to be a black box: the ACP/JSON stream carried no
 * arrival times, so "the model was slow", "a tool ran for minutes" and "acpx
 * silently restarted the agent mid-turn" were indistinguishable — and on the
 * failure paths nothing was archived at all. This module timestamps every frame
 * as it *arrives off the child's stdout* and derives the split between silence
 * spent waiting on the agent/model and silence spent inside a tool call.
 *
 * Deliberately fed from the **raw** stdout, not the compacted stream that gets
 * archived: pi restates a growing tool input once per token, so the raw arrival
 * pattern is the only place that cost is visible, and merging frames before
 * timing them would hide exactly the pathology worth seeing.
 *
 * Two real envelopes, two very different amounts of truth (live-verified
 * 2026-10-01 against hermes/pi/openclaw over ACP and opencode's part stream):
 *
 * - **Bracketed (ACP)**: `tool_call` opens an interval and a later frame closes
 *   it, so the silence between them is the tool's own execution. hermes is not
 *   perfectly bracketed — its `write:` calls never send a completion frame at
 *   all (21 of 55 in one measured design turn) — so an unmatched call is
 *   reported as {@link StepTiming.unclosedTools} instead of silently inflating
 *   the tool side.
 * - **Inline (opencode)**: every `tool_use` frame already carries
 *   `state.status: "completed"` and the result, so no interval ever opens. The
 *   model's decision and the tool's execution share one window and cannot be
 *   separated; those windows are counted as {@link StepTiming.mixedMs} and the
 *   turn is labeled `splitQuality: 'coarse'` rather than pretending to a
 *   precision the stream does not contain.
 */

/** Coarse, format-agnostic frame classification (ACP first, then JSONL part streams). */
export type StepKind =
  | 'tool_call'
  | 'tool_done'
  | 'tool_progress'
  | 'message'
  | 'thought'
  | 'turn_end'
  | 'other'

/** How trustworthy the agent/tool split is for a given envelope. */
export type SplitQuality =
  /** Tool calls are bracketed by an open and a close frame: the split is measured. */
  | 'exact'
  /** Tool results arrive already-completed, so model time and tool time share windows. */
  | 'coarse'

export interface StepFrame {
  /** 1-based arrival order within the turn. */
  n: number
  /** ms since the exec started, when this frame's terminating newline arrived. */
  tMs: number
  /** ms since the previous frame (for `n === 1`: since the exec started). */
  gapMs: number
  kind: StepKind
  /** The kind of the frame *before* this one, so a long silence can be named. */
  after: StepKind | 'exec_start'
  /** Short label of this frame (tool title, message preview). */
  detail?: string
  /** Short label of the preceding frame — what the agent was doing before a silence. */
  afterDetail?: string
}

/** One of the longest silences in a turn, and what the agent was doing before it. */
export interface Stall {
  tMs: number
  gapMs: number
  after: StepKind | 'exec_start'
  afterDetail?: string
}

/** How much of the stream we saw, and how much of it we kept. */
export interface FrameStats {
  /** Every frame seen, including ones past the retention cap. */
  seen: number
  /** Frames retained in memory and written to `timing.jsonl`. */
  retained: number
  /** Retained − seen: present in every aggregate below, absent from the file. */
  truncated: number
}

/** Where the turn's wall time went, as far as this envelope can tell. */
export interface SplitStats {
  /** Silence with no tool in flight: the agent/model producing the next frame. */
  agentMs: number
  /** Silence while a bracketed tool call was open: the tool's own execution. */
  toolMs: number
  /**
   * Windows that provably contained a tool call yet cannot be split from model
   * time — the inline envelope's shape. Present only for `coarse` splits.
   */
  mixedMs?: number
  /** Whether {@link agentMs}/{@link toolMs} are measured or partly inseparable. */
  quality: SplitQuality
  /**
   * Tool calls that opened an interval no frame ever closed. They cannot be
   * timed, and until the next `message`/`thought` frame ends the window they
   * would otherwise pull model time into {@link toolMs}.
   */
  unclosedTools?: number
}

export interface StepTiming {
  /** Wall time of the whole exec: model round-trips + tool execution + agent overhead. */
  totalMs: number
  /** Arrival of the first frame — the model's first visible output after the prompt. */
  firstFrameMs?: number
  /**
   * Stream size and retention. Frames always come from the **raw** stdout,
   * pre-compaction — that provenance used to be a `framesFrom: 'raw stdout'`
   * field, which could never hold another value and so was documentation
   * pretending to be data.
   */
  frames: FrameStats
  /** The model/tool accounting, grouped so each fact travels with its caveat. */
  split: SplitStats
  /**
   * Wall time this turn spent *not running* — the process was suspended by the
   * host (Modern Standby / S3 / hibernation), which inflates every duration in
   * this file and has twice been mistaken for a slow model (see TODO §timeout).
   */
  suspendedMs?: number
  /** How the turn ended, when it did not end cleanly. */
  exit?: { code?: number; timedOut?: boolean }
  /** The longest silences, largest first — where a long turn actually went. */
  longest: Stall[]
}

/**
 * What one `run()` recorded: the summary a human reads (`timing.json`) plus the
 * per-frame arrival timeline (`timing.jsonl`).
 *
 * Named for the pair rather than the field it feeds: this used to be
 * `StepRecording { frames, timing }`, which made the artifact writer say
 * `info.timing.timing` — a field called `timing` holding `{frames, timing}`.
 */
export interface TurnRecord {
  summary: StepTiming
  frames: StepFrame[]
}

/**
 * How many of the longest silences {@link StepTiming.longest} keeps.
 *
 * Exported because this is a *policy*, not a local detail: the recorder fills it,
 * the OTLP exporter turns those entries into span events, and the CLI summary
 * prints the first one. Three consumers, one number — they used to each decide
 * for themselves (`LONGEST_KEPT` here, `MAX_STALL_EVENTS` in otel.ts), so
 * changing one silently disagreed with the others.
 */
export const STALLS_KEPT = 5

/**
 * How many frames one turn retains in memory / writes to `timing.jsonl`. Sized
 * well above a normal turn (a 6s hermes turn is ~225 frames) and well below the
 * pathological case: pi's per-token restating produced 103.7MB of stdout in one
 * real turn (49,556 frames measured, 29,556 of them over this cap). The
 * aggregate accounting (total, agent/tool split, longest silences) stays
 * complete regardless — only the per-frame detail is capped, and
 * {@link StepTiming.framesTruncated} says so rather than pretending otherwise.
 */
const MAX_RETAINED_FRAMES = 20_000

export interface StepRecorderOptions {
  /**
   * Whether this adapter's envelope brackets its tool calls. Defaults to
   * `'exact'`; opencode-style streams that report each tool already-completed
   * must pass `'coarse'`, or their windows would be reported as pure model time.
   */
  splitQuality?: SplitQuality
}

/**
 * Collects frame arrival times for one `run()`. Feed it the child's stdout
 * chunks with the elapsed ms at which each chunk arrived; call {@link finish}
 * once the exec settles (success or failure — the failure case is the one whose
 * timeline explains it).
 */
export class StepRecorder {
  /** Retained frames, capped at {@link MAX_RETAINED_FRAMES}. */
  private readonly frames: StepFrame[] = []
  /** Every frame seen, including ones past the cap. */
  private totalFrames = 0
  /** Running top-{@link STALLS_KEPT} silences, so the cap cannot hide a long stall. */
  private readonly longest: Array<{ tMs: number; gapMs: number; after: StepKind | 'exec_start'; afterDetail?: string }> = []
  private readonly splitQuality: SplitQuality
  private buffer = ''
  private lastMs = 0
  private readonly openTools = new Set<string>()
  private toolCallsSeen = 0
  private toolCallsClosed = 0
  private agentMs = 0
  private toolMs = 0
  private mixedMs = 0
  private suspendedMs = 0
  private lastKind: StepKind | 'exec_start' = 'exec_start'
  private lastDetail: string | undefined
  private firstFrameMs: number | undefined

  constructor(opts: StepRecorderOptions = {}) {
    this.splitQuality = opts.splitQuality ?? 'exact'
  }

  /** Timestamp every complete line in `chunk` as arriving at `atMs`. */
  feed(chunk: string, atMs: number): void {
    this.buffer += chunk
    let nl = this.buffer.indexOf('\n')
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      this.push(line, atMs)
      nl = this.buffer.indexOf('\n')
    }
  }

  /**
   * Record host-level suspension (reported by the heartbeat): wall time in which
   * this process was not scheduled at all. Kept separate from the split so an
   * inflated total is self-explaining rather than looking like model latency.
   */
  addSuspended(lostMs: number): void {
    if (lostMs > 0) this.suspendedMs += lostMs
  }

  /** Close the turn. A trailing partial line is recorded with no time attributed. */
  finish(extra: { totalMs: number; exitCode?: number; timedOut?: boolean }): TurnRecord {
    if (this.buffer.trim()) {
      this.push(this.buffer, this.lastMs)
      this.buffer = ''
    }
    const unclosed = this.toolCallsSeen - this.toolCallsClosed
    return {
      frames: this.frames,
      summary: {
        totalMs: extra.totalMs,
        ...(this.firstFrameMs !== undefined ? { firstFrameMs: this.firstFrameMs } : {}),
        // Each group is always present, so the split between "measured zero" and
        // "not observable in this envelope" lives in the group's own optional
        // members instead of in seven conditional spreads at the top level.
        frames: {
          seen: this.totalFrames,
          retained: this.frames.length,
          truncated: Math.max(0, this.totalFrames - this.frames.length),
        },
        split: {
          agentMs: this.agentMs,
          toolMs: this.toolMs,
          ...(this.mixedMs > 0 ? { mixedMs: this.mixedMs } : {}),
          quality: this.splitQuality,
          ...(unclosed > 0 ? { unclosedTools: unclosed } : {}),
        },
        ...(this.suspendedMs > 0 ? { suspendedMs: this.suspendedMs } : {}),
        ...(extra.exitCode !== undefined || extra.timedOut
          ? {
              exit: {
                ...(extra.exitCode !== undefined ? { code: extra.exitCode } : {}),
                ...(extra.timedOut ? { timedOut: true } : {}),
              },
            }
          : {}),
        longest: [...this.longest],
      },
    }
  }

  private push(line: string, atMs: number): void {
    const trimmed = line.trim()
    if (!trimmed) return
    const frame = classify(trimmed)
    const gapMs = Math.max(0, atMs - this.lastMs)

    this.attributeSilence(frame, gapMs)
    if (frame.kind === 'tool_done' && frame.toolId && this.openTools.delete(frame.toolId)) {
      this.toolCallsClosed++
    }
    this.totalFrames++
    this.retainFrame(frame, atMs, gapMs)
    this.retainStall(atMs, gapMs)
    if (this.firstFrameMs === undefined) this.firstFrameMs = atMs
    if (frame.kind === 'tool_call') {
      this.toolCallsSeen++
      if (frame.toolId) this.openTools.add(frame.toolId)
    }

    this.lastMs = atMs
    this.lastKind = frame.kind
    this.lastDetail = frame.detail
  }

  /**
   * Charge the silence *preceding* this frame to the right bucket.
   *
   *  - A message/thought frame means the agent is talking again: any tool that
   *    never reported completion is over, and this silence is model time. Without
   *    this rule, one hermes `write:` call (which sends no completion frame)
   *    would pull every later silence into toolMs — measured at ~50s of a 740s
   *    turn before the rule existed.
   *  - A tool frame arriving already-completed with no interval open is the inline
   *    envelope: the window is model *and* tool, and is counted as such.
   *  - Otherwise a silence inside an open bracket is the tool's own execution.
   */
  private attributeSilence(frame: ClassifiedFrame, gapMs: number): void {
    if (frame.kind === 'message' || frame.kind === 'thought') {
      this.agentMs += gapMs
      this.openTools.clear()
    } else if (this.openTools.size > 0) {
      this.toolMs += gapMs
    } else if (frame.inlineTool) {
      this.mixedMs += gapMs
    } else {
      this.agentMs += gapMs
    }
  }

  /** Retain the frame itself, unless the cap is reached (the accounting is not). */
  private retainFrame(frame: ClassifiedFrame, atMs: number, gapMs: number): void {
    if (this.frames.length >= MAX_RETAINED_FRAMES) return
    this.frames.push({
      n: this.frames.length + 1,
      tMs: atMs,
      gapMs,
      kind: frame.kind,
      after: this.lastKind,
      ...(frame.detail ? { detail: frame.detail } : {}),
      ...(this.lastDetail ? { afterDetail: this.lastDetail } : {}),
    })
  }

  /**
   * Keep a running top-{@link STALLS_KEPT}, tracked as frames arrive rather than
   * scanned at finish: once the frame cap is reached the long stall that matters
   * may well arrive later, and "where did the time go" must not depend on the
   * detail cap.
   */
  private retainStall(atMs: number, gapMs: number): void {
    const full = this.longest.length >= STALLS_KEPT
    if (gapMs <= 0 || (full && gapMs <= this.longest[this.longest.length - 1].gapMs)) return
    this.longest.push({
      tMs: atMs,
      gapMs,
      after: this.lastKind,
      ...(this.lastDetail ? { afterDetail: this.lastDetail } : {}),
    })
    this.longest.sort((a, b) => b.gapMs - a.gapMs)
    this.longest.length = Math.min(this.longest.length, STALLS_KEPT)
  }
}

/** One-line human summary of a {@link StepTiming}, printed next to the trace line. */
export function timingSummary(t: StepTiming): string {
  const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`
  const worst = t.longest[0]
  const worstPart = worst
    ? `最长静默 ${s(worst.gapMs)} @${s(worst.tMs)} after ${worst.after}${worst.afterDetail ? ` "${worst.afterDetail}"` : ''}`
    : '无静默'
  const parts = [
    `${s(t.totalMs)} 总`,
    `首帧 ${s(t.firstFrameMs ?? 0)}`,
    `agent ${s(t.split.agentMs)}`,
    t.split.quality === 'coarse'
      ? `tool+模型 ${s(t.split.toolMs + (t.split.mixedMs ?? 0))}（不可细分）`
      : `tool ${s(t.split.toolMs)}`,
  ]
  if (t.split.unclosedTools) parts.push(`未闭合工具 ${t.split.unclosedTools}`)
  if (t.suspendedMs) parts.push(`⚠ 系统挂起 ${s(t.suspendedMs)}`)
  parts.push(`${t.frames.seen} 帧`)
  parts.push(worstPart)
  return `⏱ ${parts.join(' · ')}`
}

/**
 * Accept both the current grouped `timing.json` and the flat shape written
 * before it existed.
 *
 * This tolerance is deliberate and bounded, unlike the peer/version hedging we
 * removed elsewhere: `timing.json` is a **persisted** format, so a shape change
 * would otherwise make every archived run unreadable (the session page renders
 * spans straight from these numbers). It only has to bridge two shapes, and it
 * disappears once no flat file is worth reading.
 */
export function normalizeTiming(raw: unknown): StepTiming | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const t = raw as Record<string, unknown>
  if (typeof t.totalMs !== 'number') return undefined

  // Already grouped: `frames` is a record, `split` carries the quality.
  if (t.frames && typeof t.frames === 'object' && t.split && typeof t.split === 'object') {
    return raw as StepTiming
  }

  // Flat (pre-grouping): `frames` was the seen count, the split fields sat at the
  // top level, and `retained` was not recorded at all.
  const seen = typeof t.frames === 'number' ? t.frames : 0
  const truncated = typeof t.framesTruncated === 'number' ? t.framesTruncated : 0
  return {
    totalMs: t.totalMs,
    ...(typeof t.firstFrameMs === 'number' ? { firstFrameMs: t.firstFrameMs } : {}),
    frames: { seen, retained: Math.max(0, seen - truncated), truncated },
    split: {
      agentMs: typeof t.agentMs === 'number' ? t.agentMs : 0,
      toolMs: typeof t.toolMs === 'number' ? t.toolMs : 0,
      ...(t.mixedMs !== undefined ? { mixedMs: t.mixedMs as number } : {}),
      quality: t.splitQuality === 'coarse' ? 'coarse' : 'exact',
      ...(t.unclosedTools !== undefined ? { unclosedTools: t.unclosedTools as number } : {}),
    },
    ...(t.suspendedMs !== undefined ? { suspendedMs: t.suspendedMs as number } : {}),
    ...(t.exitCode !== undefined || t.timedOut
      ? {
          exit: {
            ...(t.exitCode !== undefined ? { code: t.exitCode as number } : {}),
            ...(t.timedOut ? { timedOut: true } : {}),
          },
        }
      : {}),
    longest: Array.isArray(t.longest) ? (t.longest as Stall[]) : [],
  }
}

interface ClassifiedFrame {
  kind: StepKind
  detail?: string
  toolId?: string
  /** A tool frame that carries its own completion: no interval can be opened. */
  inlineTool?: boolean
}

/**
 * Best-effort classification of one NDJSON line. Unknown shapes fall through to
 * `other` rather than being dropped: the timeline's job is to account for *all*
 * the silence, so an unrecognized frame still marks an arrival.
 */
function classify(line: string): ClassifiedFrame {
  let doc: unknown
  try {
    doc = JSON.parse(line)
  } catch {
    return { kind: 'other' }
  }
  const root = doc as Record<string, any>

  // ACP (`acpx --format json`): {"params":{"update":{...}}}
  const update = root?.params?.update
  if (update && typeof update === 'object') {
    const kind = String(update.sessionUpdate ?? '')
    const toolId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined
    const detail = shortDetail(update.title ?? update.content ?? update.rawInput)
    if (kind === 'tool_call') return { kind: 'tool_call', detail, toolId }
    if (kind === 'tool_call_update') {
      const status = String(update.status ?? '')
      const done = status === 'completed' || status === 'failed'
      // `kind` already says whether the call closed; a separate `toolDone` flag
      // could only ever disagree with it.
      return { kind: done ? 'tool_done' : 'tool_progress', detail, toolId }
    }
    if (kind === 'agent_message_chunk') return { kind: 'message', detail: shortDetail(update.content) }
    if (kind === 'agent_thought_chunk') return { kind: 'thought', detail: shortDetail(update.content) }
    return { kind: 'other', detail: kind || undefined }
  }

  // ACP turn boundary: the JSON-RPC response carrying the stop reason.
  if (typeof root?.result?.stopReason === 'string') {
    return { kind: 'turn_end', detail: root.result.stopReason }
  }

  // opencode `run --format json` part stream (and OpenAI-ish records). Every
  // `tool_use` here already carries `part.state.status: "completed"` plus the
  // result, so it closes nothing that was opened — hence `inlineTool`.
  const type = String(root?.type ?? '')
  const part = root?.part
  if (type.includes('tool')) {
    const done = type.includes('result') || String(part?.state?.status ?? '') === 'completed'
    return {
      kind: done ? 'tool_done' : 'tool_call',
      detail: shortDetail(part?.tool ?? root?.tool),
      ...(done ? { inlineTool: true } : {}),
    }
  }
  if (type === 'text' || type === 'message') return { kind: 'message', detail: shortDetail(part?.text ?? root?.text) }
  if (type === 'reasoning' || type === 'thought') return { kind: 'thought', detail: shortDetail(part?.text ?? root?.text) }
  if (type === 'step_start' || type === 'step_finish') return { kind: 'turn_end', detail: type }
  return { kind: 'other', detail: type || undefined }
}

/** First ~120 characters of a frame's payload, newlines flattened. */
function shortDetail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const text =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.map((v) => shortDetail(v) ?? '').join(' ')
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value)
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat
}
