import type { RetryOptions, RetryPolicy } from './types.js'
import { loadConfig } from './config-runtime.js'

/**
 * agentfoo's retry strategy (§5, the "second line of defense" against LLM output
 * variation). `fn` is a flaky assertion block — typically a turn plus its
 * assertions:
 *
 *   await retry(async () => {
 *     const trace = await hermes.run(prompt)
 *     expect(frontendDesign).toHaveBeenCalled()
 *     await expect(trace).toSatisfy(rubric)
 *   })
 *
 * Retry is deliberately opt-in per block, not a silent global (§5: it must not
 * "静默生效" on every slow test). With the default `attempts` (config `retries`
 * + 1) and the default config (`retries: 0`), this runs `fn` exactly once, so
 * wrapping a block is a no-op until retries are configured.
 *
 * The pass-decision `policy` (§5 left this to implementation):
 * - 'any' (default): pass the moment one attempt succeeds; fail only if every
 *   attempt throws. Absorbs an unlucky sample — the doc's framing of retry as a
 *   defense against flaky *false failures*.
 * - 'majority': run all attempts, pass iff a strict majority succeed. A stricter
 *   gate that guards against a lucky *false pass* on an unreliable skill.
 */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? loadConfig().retries + 1)
  const policy = options.policy ?? 'any'
  return policy === 'majority' ? retryMajority(fn, attempts) : retryAny(fn, attempts)
}

async function retryAny<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  const errors: unknown[] = []
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      errors.push(err)
    }
  }
  throw aggregateError(errors, attempts, 'any')
}

async function retryMajority<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  const errors: unknown[] = []
  let lastValue: T | undefined
  let passes = 0
  for (let i = 0; i < attempts; i++) {
    try {
      lastValue = await fn()
      passes++
    } catch (err) {
      errors.push(err)
    }
  }
  if (passes * 2 > attempts) return lastValue as T
  throw aggregateError(errors, attempts, 'majority', passes)
}

function aggregateError(
  errors: unknown[],
  attempts: number,
  policy: RetryPolicy,
  passes = 0,
): Error {
  const head =
    policy === 'majority'
      ? `retry(policy: majority) failed: only ${passes}/${attempts} attempts passed`
      : `retry(policy: any) failed: all ${attempts} attempt(s) threw`
  const detail = errors.map((e, i) => `  attempt ${i + 1}: ${errString(e)}`).join('\n')
  const agg = new Error(detail ? `${head}\n${detail}` : head)
  // Keep the last failure as the cause so tooling that unwraps it still works.
  ;(agg as Error & { cause?: unknown }).cause = errors[errors.length - 1]
  return agg
}

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
