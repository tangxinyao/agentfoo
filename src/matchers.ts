import { expect } from 'vitest'
import type { Rubric, SatisfyOptions, Trace } from './types.js'
import { SkillHandle } from './skill.js'
import { judge as runJudge, defaultThreshold } from './judge.js'
import { loadConfig } from './config-runtime.js'
import { withHeartbeat } from './progress.js'

/**
 * Custom matchers (§5).
 *
 * - `toSatisfy` is an LLM-judge (rubric) matcher and is therefore ASYNC: it must
 *   be awaited (`await expect(trace).toSatisfy(...)`). This is a deliberate,
 *   documented deviation from the doc's await-less snippets — a real judge call
 *   is a network round-trip and cannot be synchronous.
 * - `toHaveBeenCalled` / `toHaveBeenCalledWith` are synchronous spy matchers over
 *   a {@link SkillHandle}.
 */

function satisfyTarget(received: unknown): { label: string; text: string } {
  if (typeof received === 'string') return { label: 'string', text: received }
  if (isTrace(received)) return { label: 'trace', text: received.text() }
  throw new Error('toSatisfy expects a Trace, trace.finalMessage string, or any string.')
}

function isTrace(v: unknown): v is Trace {
  return !!v && typeof v === 'object' && typeof (v as Trace).text === 'function'
}

expect.extend({
  async toSatisfy(received: unknown, rubric: Rubric, options: SatisfyOptions = {}) {
    const { text } = satisfyTarget(received)
    const cfg = loadConfig()
    const model = options.model ?? cfg.judge.model
    const threshold = options.threshold ?? defaultThreshold(rubric)

    const criteria = Array.isArray(rubric) ? rubric.length : 1
    const result = await withHeartbeat(
      `judging (${model}, ${criteria} ${criteria === 1 ? 'criterion' : 'criteria'})`,
      // Spread the whole configured judge block, not just the model: baseUrl,
      // apiKeyEnv and maxTokens are all part of "how to reach the judge" and
      // silently dropping them makes a configured endpoint/key look ignored.
      () => runJudge(text, rubric, { ...cfg.judge, model }, threshold),
    )

    const summary = result.breakdown
      .map((b) => `  ${b.met ? '✓' : '✗'} (${b.weight}) ${b.criteria}\n      ↳ ${b.reason}`)
      .join('\n')

    return {
      pass: result.passed,
      message: () =>
        `rubric score ${result.score.toFixed(2)} ` +
        `${result.passed ? '≥' : '<'} threshold ${threshold.toFixed(2)}\n${summary}`,
      actual: result.score,
      expected: threshold,
    }
  },

  toHaveBeenCalled(received: unknown) {
    const handle = asSkill(received)
    const calls = handle.calls()
    return {
      pass: calls.length > 0,
      message: () =>
        calls.length > 0
          ? `expected skill "${handle.name}" not to have been called, but it was ${calls.length}×`
          : `expected skill "${handle.name}" to have been called, but it was not.\n` +
            notCalledDiagnostics(handle),
    }
  },

  toHaveBeenCalledWith(received: unknown, expectedArgs: Record<string, unknown>) {
    const handle = asSkill(received)
    const calls = handle.calls()
    const match = calls.find((c) => argsContain(c.arguments, expectedArgs))
    return {
      pass: !!match,
      message: () =>
        match
          ? `expected skill "${handle.name}" not to have been called with ${JSON.stringify(expectedArgs)}`
          : `expected skill "${handle.name}" to have been called with ${JSON.stringify(expectedArgs)}, ` +
            `observed calls: ${JSON.stringify(calls.map((c) => c.arguments))}`,
    }
  },
})

/**
 * Explain a failing `toHaveBeenCalled` by listing the tool calls that *were*
 * observed. Distinguishes "the skill never fired" from "it fired but the §11
 * detection heuristic missed the signal" — the second case is the one the user
 * can fix with `setSkillDetector`.
 */
function notCalledDiagnostics(handle: SkillHandle): string {
  const observed = handle.observedToolCalls()
  if (observed.length === 0) {
    return '  No tool calls were recorded in this run at all — the agent likely never engaged the skill.'
  }
  const names = observed.map((c) => c.name)
  const tally = [...countBy(names).entries()]
    .map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
    .join(', ')
  return (
    `  ${observed.length} tool call(s) were observed but none matched the skill-invocation\n` +
    `  heuristic (§11, UNVERIFIED). If one of these represents the skill firing, pin the\n` +
    `  signal with setSkillDetector(...). Observed: ${tally}`
  )
}

function countBy(items: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1)
  return m
}

function asSkill(received: unknown): SkillHandle {
  if (received instanceof SkillHandle) return received
  throw new Error(
    'toHaveBeenCalled / toHaveBeenCalledWith expect a skill handle returned by hermes.loadSkill(...).',
  )
}

/** Shallow subset match: every expected key must deep-equal in the actual args. */
function argsContain(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([k, v]) => deepEqual(actual[k], v))
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const keys = Object.keys(bo)
    return keys.every((k) => deepEqual(ao[k], bo[k]))
  }
  return false
}

interface AgentfooMatchers<R = unknown> {
  /** Assert the skill handle was invoked at least once. */
  toHaveBeenCalled(): R
  /** Assert the skill was invoked with arguments containing `expectedArgs`. */
  toHaveBeenCalledWith(expectedArgs: Record<string, unknown>): R
}

declare module 'vitest' {
  // `toSatisfy` must be declared *directly* on `Assertion` (not inherited via
  // `extends AgentfooMatchers`) so it merges as an overload with vitest's
  // built-in `toSatisfy(predicate)`. An inherited member is shadowed by the
  // interface's own built-in signature; a merged declaration coexists with it,
  // so `toSatisfy([{criteria,weight}], opts)` resolves to the rubric overload.
  interface Assertion<T = any> extends AgentfooMatchers<T> {
    /** LLM-judge assertion (§5). ASYNC — must be awaited. */
    toSatisfy(rubric: Rubric, options?: SatisfyOptions): Promise<T>
  }
  interface AsymmetricMatchersContaining extends AgentfooMatchers {
    toSatisfy(rubric: Rubric, options?: SatisfyOptions): Promise<void>
  }
}
