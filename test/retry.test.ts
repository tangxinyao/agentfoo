import { describe, it, expect } from 'vitest'
import { retry } from '../src/retry.js'

/** A fn that throws for its first `failFirst` calls, then resolves to `value`. */
function flaky<T>(failFirst: number, value: T): { fn: () => Promise<T>; calls: () => number } {
  let n = 0
  return {
    fn: async () => {
      n++
      if (n <= failFirst) throw new Error(`boom ${n}`)
      return value
    },
    calls: () => n,
  }
}

describe('retry', () => {
  it("defaults to a single attempt (retries off) so wrapping is a no-op", async () => {
    const { fn, calls } = flaky(0, 'ok')
    await expect(retry(fn)).resolves.toBe('ok')
    expect(calls()).toBe(1)
  })

  it("default policy 'any' passes as soon as one attempt succeeds", async () => {
    const { fn, calls } = flaky(2, 'ok')
    await expect(retry(fn, { attempts: 3 })).resolves.toBe('ok')
    expect(calls()).toBe(3) // failed twice, succeeded on the third
  })

  it("policy 'any' stops early on the first success", async () => {
    const { fn, calls } = flaky(0, 'ok')
    await retry(fn, { attempts: 5 })
    expect(calls()).toBe(1)
  })

  it("policy 'any' aggregates every failure when all attempts throw", async () => {
    const { fn } = flaky(3, 'ok')
    await expect(retry(fn, { attempts: 3 })).rejects.toThrow(/all 3 attempt\(s\) threw/)
  })

  it("policy 'majority' passes on a strict majority of successes", async () => {
    const { fn, calls } = flaky(1, 'ok') // fail 1, pass 2 of 3
    await expect(retry(fn, { attempts: 3, policy: 'majority' })).resolves.toBe('ok')
    expect(calls()).toBe(3) // runs ALL attempts, never short-circuits
  })

  it("policy 'majority' fails without a strict majority (ties lose)", async () => {
    const { fn } = flaky(2, 'ok') // fail 2, pass 2 of 4 → 2*2 == 4, not > 4
    await expect(retry(fn, { attempts: 4, policy: 'majority' })).rejects.toThrow(
      /only 2\/4 attempts passed/,
    )
  })

  it('preserves the last failure as the error cause', async () => {
    const { fn } = flaky(2, 'ok')
    // `catch` widens the result to the promise's own resolved type (a string
    // here) unioned with the handler's return, so the rejection needs naming.
    const err = (await retry(fn, { attempts: 2 }).catch((e) => e)) as Error & { cause?: Error }
    expect((err.cause as Error).message).toBe('boom 2')
  })
})
