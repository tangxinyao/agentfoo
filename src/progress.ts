/**
 * Live progress logging for agentfoo runs (§ visibility).
 *
 * Everything slow — the docker image build, container boot, the agent
 * round-trip, the judge call — happens inside vitest workers, where the default
 * reporter stays silent until a test *settles*. On a live suite that leaves the
 * terminal blank for minutes, so you can't tell a slow run from a hung one.
 *
 * These helpers write short status lines to stderr. Paired with
 * `disableConsoleIntercept` in the agentfoo vitest config (§6), the lines
 * surface in real time. `withHeartbeat` additionally ticks an elapsed-seconds
 * line while a long await is in flight, so a working run visibly makes progress.
 *
 * Set `AGENTFOO_QUIET=1` to silence all of it (e.g. in CI logs).
 */

const enabled = process.env.AGENTFOO_QUIET !== '1'
// Whether the terminal at the end of the pipe is interactive (propagated from
// the CLI, since the worker's own stderr is a pipe). Gates in-place refresh.
const interactive = process.env.AGENTFOO_TTY === '1'
// Terminal width, likewise propagated from the CLI. Used to truncate the whole
// refresh line so it never wraps; a wrapped line breaks `\r` (it only returns
// to the current physical row). 0 ⇒ width unknown ⇒ no cap.
const columns = Number(process.env.AGENTFOO_COLUMNS) || 0

/** Wall-clock `HH:MM:SS`, so the reader can eyeball how long a phase took. */
function stamp(): string {
  return new Date().toTimeString().slice(0, 8)
}

/**
 * The transient line an in-place heartbeat leaves on screen, and the only way
 * `progress()` may clear it.
 *
 * Module state by nature — both writers live in this module — but reached only
 * through these two calls, so a heartbeat cannot leave a half-written "…12s"
 * fragment in front of an unrelated line.
 */
const transientLine = {
  on: false,
  /** `\r\x1b[K` when a transient line is on screen, else empty. */
  consumeClear(): string {
    const prefix = this.on ? '\r\x1b[K' : ''
    this.on = false
    return prefix
  },
}

/** Print one permanent status line to stderr (no-op when quieted). */
export function progress(msg: string): void {
  if (!enabled) return
  // If a heartbeat line is still on screen, clear it first so this line isn't
  // appended after a half-written "…12s" fragment.
  process.stderr.write(`${transientLine.consumeClear()}  agentfoo ${stamp()}  ${msg}\n`)
}

/** Truncate a prompt for a one-line label. */
export function preview(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Best-effort display width in terminal cells. East Asian ideographs, kana,
 * Hangul, fullwidth forms and emoji occupy two cells each — counting them as
 * one (as `String.length` does) would make `fit` under-truncate and let CJK
 * prompts wrap anyway, which is exactly the case this tool sees most. This is
 * the standard wcwidth range approximation, kept inline to avoid a dependency.
 */
function cellWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    const wide =
      c >= 0x1100 &&
      (c <= 0x115f || // Hangul Jamo
        c === 0x2329 ||
        c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || // CJK … Yi
        (c >= 0xac00 && c <= 0xd7a3) || // Hangul syllables
        (c >= 0xf900 && c <= 0xfaff) || // CJK compat ideographs
        (c >= 0xfe30 && c <= 0xfe4f) || // CJK compat forms
        (c >= 0xff00 && c <= 0xff60) || // fullwidth forms
        (c >= 0xffe0 && c <= 0xffe6) ||
        (c >= 0x1f300 && c <= 0x1faff) || // emoji
        (c >= 0x20000 && c <= 0x3fffd)) // CJK ext B+
    w += wide ? 2 : 1
  }
  return w
}

/**
 * Cap a full status line to the terminal width so it never wraps (wrapping
 * would leave `\r` unable to overwrite the earlier physical rows). Measured in
 * display cells, not code units, so wide (CJK/emoji) content is trimmed
 * correctly. One column of margin avoids the terminal's autowrap-at-margin
 * ambiguity. No-op when the width is unknown.
 */
function fit(line: string): string {
  const max = columns - 1
  if (max <= 0 || cellWidth(line) <= max) return line
  let w = 0
  let out = ''
  for (const ch of line) {
    const cw = cellWidth(ch)
    if (w + cw > max - 1) break // reserve one cell for the ellipsis
    w += cw
    out += ch
  }
  return `${out}…`
}

/**
 * How much of a late heartbeat tick was *not* the process running.
 *
 * Zero unless the tick arrived more than `thresholdMs` after it was due, which
 * is the signature of a host-level suspension: a slow machine delays a tick, it
 * does not skip twenty minutes of them. Exported for unit tests.
 */
export function suspendLostMs(sinceLastTickMs: number, intervalMs: number, thresholdMs: number): number {
  return sinceLastTickMs > thresholdMs ? sinceLastTickMs - intervalMs : 0
}

/** How often the elapsed line refreshes by default. */
const DEFAULT_TICK_MS = 15_000

/**
 * How late a tick must be before the host counts as having frozen us.
 *
 * Deliberately *not* derived from {@link DEFAULT_TICK_MS} any more: detection
 * sensitivity and redraw frequency are different policies, and deriving one from
 * the other meant that asking for a faster display silently made suspensions
 * three times harder to notice. Three missed default ticks.
 */
const DEFAULT_SUSPEND_AFTER_MS = 45_000

/** Interactive output refreshes once a second, whatever the tick policy is. */
const IN_PLACE_REFRESH_MS = 1_000

export interface HeartbeatOptions {
  /** Elapsed-line cadence; the append sink prints one line per tick. */
  tickMs?: number
  /** A tick later than this means the host suspended us (see {@link suspendLostMs}). */
  suspendAfterMs?: number
  /** Receives the lost wall time, so a timeline can exclude it. */
  onSuspend?: (lostMs: number) => void
}

/** Where a heartbeat's progress goes: one shape for a TTY, one for a pipe. */
interface HeartbeatSink {
  start(label: string): void
  tick(label: string, secs: string): void
  done(label: string, ok: boolean, secs: string): void
}

/** Piped/redirected, where `\r` would not render: every update is its own line. */
const appendSink: HeartbeatSink = {
  start: (label) => progress(`▶ ${label}`),
  tick: (_label, secs) => process.stderr.write(`  agentfoo ${stamp()}  ⏳ ${secs}s elapsed\n`),
  done: (label, ok, secs) =>
    progress(ok ? `✔ ${label} — ${secs}s` : `✗ ${label} — failed after ${secs}s`),
}

/**
 * Interactive: collapse start + heartbeat + done onto one self-refreshing line.
 * `\r` returns to column 0, `\x1b[K` erases any leftover from a longer previous
 * frame, and `fit` keeps the whole line inside the terminal width so it never
 * wraps (which would defeat the `\r`).
 */
const inPlaceSink: HeartbeatSink = {
  start: (label) => {
    renderHeartbeat(label, '▶')
    transientLine.on = true
  },
  tick: (label, secs) => {
    renderHeartbeat(label, '▶', `  ${secs}s`)
    transientLine.on = true
  },
  done: (label, ok, secs) => {
    renderHeartbeat(label, ok ? '✔' : '✗', ok ? ` — ${secs}s` : ` — failed after ${secs}s`)
    process.stderr.write('\n') // commit the line; the next output starts on its own row
    transientLine.on = false
  },
}

function renderHeartbeat(label: string, mark: string, extra = ''): void {
  process.stderr.write(`\r${fit(`  agentfoo ${stamp()}  ${mark} ${label}${extra}`)}\x1b[K`)
}

/**
 * Run `fn` with visible progress, turning a silent multi-minute await into
 * something you can watch: a start line, a growing elapsed count, and a
 * done/failed line — refreshed in place on a TTY, appended when the output is
 * piped, so nothing is lost in a file or CI log.
 */
export async function withHeartbeat<T>(
  label: string,
  fn: () => Promise<T>,
  options: HeartbeatOptions = {},
): Promise<T> {
  if (!enabled) return fn()
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS
  const suspendAfterMs = options.suspendAfterMs ?? DEFAULT_SUSPEND_AFTER_MS
  const start = Date.now()
  const secs = (): string => ((Date.now() - start) / 1000).toFixed(0)

  // A timer firing far later than scheduled means this process was not running
  // at all. Measured twice on this repo's own box (2026-10-01): Modern Standby
  // froze a 2255s turn for 1362s of it and a 97s stretch elsewhere, and both
  // times the inflated duration was first read as "the model was slow". Name it
  // in the log and hand the number to the caller so `timing.json` explains
  // itself instead of needing this forensics again.
  let lastCheck = Date.now()
  const check = (): void => {
    const now = Date.now()
    if (now - lastCheck < tickMs) return
    const lost = suspendLostMs(now - lastCheck, tickMs, suspendAfterMs)
    lastCheck = now
    if (lost <= 0) return
    options.onSuspend?.(lost)
    progress(
      `⚠ 检测到 ${(lost / 1000).toFixed(0)}s 无 tick：进程被挂起（睡眠/休眠/VM 暂停），` +
        '这段墙钟时间不代表模型或工具耗时',
    )
  }

  const sink = interactive ? inPlaceSink : appendSink
  sink.start(label)
  const timer = setInterval(() => {
    check()
    sink.tick(label, secs())
  }, interactive ? IN_PLACE_REFRESH_MS : tickMs)
  // Don't let the heartbeat keep the event loop alive on its own.
  timer.unref?.()
  try {
    const result = await fn()
    sink.done(label, true, secs())
    return result
  } catch (err) {
    sink.done(label, false, secs())
    throw err
  } finally {
    clearInterval(timer)
  }
}
