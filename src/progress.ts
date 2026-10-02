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

/** Whether a transient (un-terminated) heartbeat line is currently on screen. */
let pending = false

/** Print one permanent status line to stderr (no-op when quieted). */
export function progress(msg: string): void {
  if (!enabled) return
  // If a heartbeat line is still on screen, clear it first so this line isn't
  // appended after a half-written "…12s" fragment.
  const prefix = pending ? '\r\x1b[K' : ''
  pending = false
  process.stderr.write(`${prefix}  agentfoo ${stamp()}  ${msg}\n`)
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
 * Run `fn` with visible progress, turning a silent multi-minute await into
 * something you can watch. Two shapes depending on the sink:
 *
 * - Interactive TTY: a single line that refreshes in place — the timestamp
 *   reticks and the elapsed count grows every second, and on completion the
 *   leading `▶` becomes `✔`/`✗` with the total on that same line before a
 *   newline commits it (so the following trace lands on its own row).
 * - Piped/redirected (where `\r` wouldn't render): the append form — a start
 *   line, a fresh elapsed line every `intervalMs`, and a done/failed line — so
 *   nothing is lost in a file or CI log.
 */
export async function withHeartbeat<T>(
  label: string,
  fn: () => Promise<T>,
  intervalMs = 15_000,
): Promise<T> {
  if (!enabled) return fn()
  const start = Date.now()
  const secs = () => ((Date.now() - start) / 1000).toFixed(0)

  if (!interactive) {
    progress(`▶ ${label}`)
    const timer = setInterval(() => {
      process.stderr.write(`  agentfoo ${stamp()}  ⏳ ${secs()}s elapsed\n`)
    }, intervalMs)
    // Don't let the heartbeat keep the event loop alive on its own.
    timer.unref?.()
    try {
      const result = await fn()
      progress(`✔ ${label} — ${secs()}s`)
      return result
    } catch (err) {
      progress(`✗ ${label} — failed after ${secs()}s`)
      throw err
    } finally {
      clearInterval(timer)
    }
  }

  // Interactive: collapse start + heartbeat + done onto one self-refreshing
  // line. `\r` returns to column 0, `\x1b[K` erases any leftover from a longer
  // previous frame, and `fit` keeps the whole line inside the terminal width so
  // it never wraps (which would defeat the `\r`).
  const render = (mark: string, extra = '') =>
    process.stderr.write(`\r${fit(`  agentfoo ${stamp()}  ${mark} ${label}${extra}`)}\x1b[K`)
  render('▶')
  pending = true
  const timer = setInterval(() => render('▶', `  ${secs()}s`), 1_000)
  timer.unref?.()
  try {
    const result = await fn()
    render('✔', ` — ${secs()}s`) // overwrite ▶ in place
    process.stderr.write('\n') // commit the line; trace follows on the next row
    pending = false
    return result
  } catch (err) {
    render('✗', ` — failed after ${secs()}s`)
    process.stderr.write('\n')
    pending = false
    throw err
  } finally {
    clearInterval(timer)
  }
}
