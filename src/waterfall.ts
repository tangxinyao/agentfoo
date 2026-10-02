import { spanTree } from './otel.js'
import type { PlannedSpan } from './otel.js'

/**
 * Waterfall layout for the session page, computed on the server.
 *
 * This is the geometry that used to live inside the page's `<script>`: percentage
 * positions, bar segments, stall markers, nesting depth. It was ~45 lines of math
 * embedded in a template string, covered by a single "does the script parse" test
 * — the one part of the OTel view that could be wrong without anything noticing.
 * Pure and in TypeScript, it is testable, and the page is left with nothing but
 * DOM building.
 */

/** One span, laid out for a waterfall. All geometry is a percentage of the run. */
export interface WaterfallRow {
  key: string
  name: string
  kind: 'run' | 'test' | 'turn'
  /** Nesting level, for indentation (0 = the run). */
  depth: number
  leftPct: number
  widthPct: number
  durationMs: number
  failed: boolean
  status?: { code: number; message?: string }
  /**
   * Turn rows only: the model/tool/mixed split *inside* this span's own bar, as
   * percentages of the row. Empty for a row that has nothing to split.
   */
  segments: Array<{ kind: 'agent' | 'tool' | 'mixed'; pct: number }>
  /** Stall markers, positioned within the row. */
  events: Array<{ name: string; leftPct: number; title: string }>
  /** Attributes as printable pairs (arrays joined), in a stable order. */
  attributes: Array<[string, string]>
  /** Events as printable lines, for the row's detail list. */
  eventDetails: Array<{ name: string; text: string }>
}

export interface Waterfall {
  rows: WaterfallRow[]
  /** Wall time the whole view spans, in ms (>= 1, so percentages are finite). */
  totalMs: number
  spanCount: number
}

const SPAN_STATUS_ERROR = 2

function printable(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ')
  return String(value)
}

function numberAttr(span: PlannedSpan, key: string): number {
  const value = span.attributes[key]
  return typeof value === 'number' ? value : 0
}

function kindOf(key: string): WaterfallRow['kind'] {
  if (key === 'run') return 'run'
  return key.includes(':turn:') ? 'turn' : 'test'
}

/** The model/tool/mixed split as percentages of the turn's own measured total. */
function splitSegments(span: PlannedSpan): WaterfallRow['segments'] {
  if (kindOf(span.key) !== 'turn') return []
  const agent = numberAttr(span, 'agentfoo.agent_ms')
  const tool = numberAttr(span, 'agentfoo.tool_ms')
  const mixed = numberAttr(span, 'agentfoo.mixed_ms')
  const sum = agent + tool + mixed
  if (sum <= 0) return []
  const pct = (v: number): number => (100 * v) / sum
  return [
    { kind: 'agent' as const, pct: pct(agent) },
    { kind: 'tool' as const, pct: pct(tool) },
    { kind: 'mixed' as const, pct: pct(mixed) },
  ].filter((s) => s.pct > 0)
}

export function buildWaterfall(spans: PlannedSpan[]): Waterfall {
  const tree = spanTree(spans)
  if (spans.length === 0) return { rows: [], totalMs: 0, spanCount: 0 }

  const start = Math.min(...spans.map((s) => s.startMs))
  const end = Math.max(...spans.map((s) => s.endMs))
  const totalMs = Math.max(1, end - start)

  const depthOf = (span: PlannedSpan): number => {
    let depth = 0
    let parent = span.parentKey
    while (parent) {
      depth++
      parent = tree.byKey.get(parent)?.parentKey
    }
    return depth
  }

  const rows = spans.map((span): WaterfallRow => {
    const durationMs = Math.max(0, span.endMs - span.startMs)
    const failure = span.status?.code === SPAN_STATUS_ERROR
    return {
      key: span.key,
      name: span.name,
      kind: kindOf(span.key),
      depth: depthOf(span),
      leftPct: (100 * (span.startMs - start)) / totalMs,
      // A zero-length span still has to be visible: half a percent is enough to
      // click, and never wider than the span's actual share.
      widthPct: Math.max(0.5, (100 * durationMs) / totalMs),
      durationMs,
      failed: failure,
      ...(span.status ? { status: span.status } : {}),
      segments: splitSegments(span),
      events: span.events.map((event) => ({
        name: event.name,
        leftPct: Math.min(99.5, Math.max(0, (100 * (event.timeMs - span.startMs)) / Math.max(1, durationMs))),
        title: `${event.name}: ${printable(event.attributes['agentfoo.stall.gap_ms'] ?? '')}ms after ${printable(event.attributes['agentfoo.stall.after'] ?? '?')}`,
      })),
      attributes: Object.entries(span.attributes).map(([k, v]) => [k, printable(v)]),
      eventDetails: span.events.map((event) => ({
        name: event.name,
        text: Object.entries(event.attributes)
          .map(([k, v]) => `${k}=${printable(v)}`)
          .join('  '),
      })),
    }
  })

  return { rows, totalMs, spanCount: spans.length }
}
