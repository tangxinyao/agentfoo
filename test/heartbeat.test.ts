import { describe, expect, it } from 'vitest'
import { suspendLostMs } from '../src/progress.js'

/**
 * Host suspension detector (TODO §timeout).
 *
 * The heartbeat's own tick spacing is the cheapest possible probe for "this
 * process was not running": a loaded machine delays a tick, but only the host
 * suspending the whole VM (Modern Standby / S3 / hibernation) skips twenty
 * minutes of them. Both freezes measured on 2026-10-01 were first read as a slow
 * model, so the arithmetic that separates them gets pinned here.
 */
describe('suspendLostMs', () => {
  it('reports nothing for a tick that was merely late', () => {
    expect(suspendLostMs(15_200, 15_000, 45_000)).toBe(0)
    expect(suspendLostMs(44_999, 15_000, 45_000)).toBe(0)
  })

  it('ignores a tick landing exactly on the threshold', () => {
    expect(suspendLostMs(45_000, 15_000, 45_000)).toBe(0)
  })

  it('reports the unaccounted wall time when the process was not scheduled', () => {
    // The measured pi freeze: 1377s between two printed ticks, one of which was due.
    expect(suspendLostMs(1_377_000, 15_000, 45_000)).toBe(1_362_000)
    // The shorter openclaw one, 97s.
    expect(suspendLostMs(97_000, 15_000, 45_000)).toBe(82_000)
  })
})
