import { expect } from 'vitest'
import type { JudgeRecord, JudgeResult, Rubric, SatisfyOptions, SatisfyTarget, Trace } from './types.js'
import { SkillHandle } from './skill.js'
import { judge as runJudge, defaultThreshold } from './judge.js'
import { loadConfig } from './config-runtime.js'
import { progress, withHeartbeat } from './progress.js'
import { nextJudgeIndex, recordJudgeArtifact, recordTriggerArtifact } from './artifacts.js'

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

/**
 * Pick the text the judge sees. A Trace defaults to its `finalMessage`: the full
 * transcript includes tool results, and for agents that load a skill by reading
 * SKILL.md (pi, openclaw) the skill's own instructions — "explain the analogy's
 * limits", "correct a common misconception" — would be graded as the answer.
 * Measured on pi: the same weak answer passed 3/3 as a transcript, 1/3 alone.
 */
function satisfyTarget(
  received: unknown,
  target: SatisfyTarget = 'final',
): { target: JudgeRecord['target']; text: string } {
  if (typeof received === 'string') return { target: 'string', text: received }
  if (isTrace(received)) {
    return target === 'transcript'
      ? { target, text: received.text() }
      : { target, text: received.finalMessage }
  }
  throw new Error('toSatisfy expects a Trace, trace.finalMessage string, or any string.')
}

function isTrace(v: unknown): v is Trace {
  return !!v && typeof v === 'object' && typeof (v as Trace).text === 'function'
}

expect.extend({
  async toSatisfy(received: unknown, rubric: Rubric, options: SatisfyOptions = {}) {
    // Trigger-only runs (`agentfoo optimize-description`) measure whether a skill
    // fires, not how well it writes: skip the judge — and its cost — entirely.
    if (process.env.AGENTFOO_TRIGGER_ONLY === '1') {
      return { pass: !this.isNot, message: () => 'toSatisfy skipped (AGENTFOO_TRIGGER_ONLY=1)' }
    }
    // Read before the first await: concurrent tests interleave after that point.
    const testName = takeAssertionTest() ?? this.currentTestName ?? expect.getState().currentTestName ?? 'unknown'
    const { target, text } = satisfyTarget(received, options.target)
    const cfg = loadConfig()
    const model = options.model ?? cfg.judge.model
    const threshold = options.threshold ?? defaultThreshold(rubric)

    const samples = Math.max(1, Math.floor(options.samples ?? cfg.judge.samples ?? 1))

    const criteria = Array.isArray(rubric) ? rubric.length : 1
    const results = await withHeartbeat(
      `judging (${model}, ${criteria} ${criteria === 1 ? 'criterion' : 'criteria'}` +
        `${samples > 1 ? `, ×${samples}` : ''})`,
      // Spread the whole configured judge block, not just the model: baseUrl,
      // apiKeyEnv and maxTokens are all part of "how to reach the judge" and
      // silently dropping them makes a configured endpoint/key look ignored.
      () =>
        Promise.all(
          Array.from({ length: samples }, () => runJudge(text, rubric, { ...cfg.judge, model }, threshold)),
        ),
    )
    const result = aggregate(results, threshold)
    const scores = results.map((r) => r.score)
    const sd = stdev(scores)

    progress(
      `  score ${result.score.toFixed(2)}${samples > 1 ? `±${sd.toFixed(2)} (n=${samples})` : ''} ` +
        `${result.passed ? '≥' : '<'} ${threshold.toFixed(2)}` +
        (result.passed ? '' : ` — ${result.breakdown.filter((b) => !b.met).length} unmet`),
    )
    try {
      recordJudgeArtifact({
        test: testName,
        index: nextJudgeIndex(testName),
        model,
        target,
        threshold,
        score: result.score,
        passed: result.passed,
        breakdown: result.breakdown,
        samples,
        scores,
        stdev: sd,
        gradedAt: new Date().toISOString(),
      })
    } catch {
      // Artifact writing must never fail a test.
    }

    const summary = result.breakdown
      .map(
        (b) =>
          `  ${b.met ? '✓' : '✗'} (${b.weight}) ${b.criteria}` +
          `${b.metRate !== undefined ? ` [met ${Math.round(b.metRate * samples)}/${samples}]` : ''}` +
          `\n      ↳ ${b.reason}`,
      )
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
    try {
      recordTriggerArtifact({
        test: takeAssertionTest() ?? this.currentTestName ?? expect.getState().currentTestName ?? 'unknown',
        skill: handle.name,
        called: calls.length > 0,
        expected: !this.isNot,
      })
    } catch {
      // Artifact writing must never fail a test.
    }
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
 * Fold several gradings of the same text into one. The score is the mean of the
 * sample scores (not re-derived from majority verdicts, so a criterion met 2/3 of
 * the time still costs a third of its weight); each criterion's `met` is the
 * majority and `metRate` the fraction, with the reason taken from a sample that
 * agrees with the majority. A single sample passes through unchanged.
 */
export function aggregate(results: JudgeResult[], threshold: number): JudgeResult {
  if (results.length === 1) return results[0]
  const score = results.reduce((s, r) => s + r.score, 0) / results.length
  const breakdown = results[0].breakdown.map((first, i) => {
    const verdicts = results.map((r) => r.breakdown[i])
    const metRate = verdicts.filter((v) => v?.met).length / results.length
    const met = metRate > 0.5
    const agreeing = verdicts.find((v) => v && v.met === met) ?? first
    return { criteria: first.criteria, weight: first.weight, met, reason: agreeing.reason, metRate }
  })
  return { passed: score >= threshold, score, threshold, breakdown }
}

function stdev(xs: number[]): number {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length)
}

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

/**
 * Keep agentfoo's `toSatisfy` in place on chai's shared `Assertion.prototype`.
 *
 * vitest ships its own `toSatisfy(predicate)` and re-registers it every time it
 * builds a test-context `expect` — which happens lazily, the moment a test
 * destructures `({ expect })`, as `test.concurrent` requires. That assignment
 * lands on the same prototype, so after the first such test every
 * `toSatisfy(rubric)` in the file, global `expect` included, silently became
 * vitest's predicate matcher and failed with "expected is not a function".
 *
 * chai's `addMethod` assigns (`proto[name] = fn`), so an accessor catches it: the
 * setter keeps vitest's version as the fallback, and the getter dispatches — a
 * function argument goes to vitest's predicate matcher, anything else (a
 * rubric) to ours. Both keep working, whichever registered last.
 */
/**
 * The test an assertion belongs to. A matcher's `this.currentTestName` comes from
 * the `expect` that *registered* it (the global one), so under `test.concurrent`
 * it names whichever test started last — gradings and trigger records landed
 * on the wrong cases. vitest does tag every assertion with its own test
 * (`vitest-test` flag); the prototype wrappers below read it off the assertion
 * right before delegating, and the matcher takes it synchronously.
 */
let assertionTest: string | undefined

function takeAssertionTest(): string | undefined {
  const t = assertionTest
  assertionTest = undefined
  return t
}

interface TaskLike {
  name: string
  suite?: (TaskLike & { filepath?: string }) | undefined
}

function noteAssertionTest(assertion: unknown): void {
  const task = (assertion as { __flags?: Record<string, unknown> } | undefined)?.__flags?.['vitest-test'] as TaskLike | undefined
  if (!task?.name) {
    assertionTest = undefined
    return
  }
  const names = [task.name]
  for (let s = task.suite; s && !('filepath' in s && s.filepath); s = s.suite) names.unshift(s.name)
  assertionTest = names.join(' > ')
}

/** Prototype methods already wrapped (chai proxies its methods, so no marker property on them). */
const tagged = new WeakSet<object>()

/** Wrap agentfoo's spy matchers so they know which test is asserting (see {@link noteAssertionTest}). */
function tagSpyMatchers(): void {
  const proto = Object.getPrototypeOf(expect(null)) as Record<string, (...args: unknown[]) => unknown>
  for (const name of ['toHaveBeenCalled', 'toHaveBeenCalledWith']) {
    const original = Object.getOwnPropertyDescriptor(proto, name)?.value as ((...args: unknown[]) => unknown) | undefined
    if (typeof original !== 'function' || tagged.has(original)) continue
    const wrapped = function (this: unknown, ...args: unknown[]) {
      noteAssertionTest(this)
      return original.apply(this, args)
    }
    tagged.add(wrapped)
    Object.defineProperty(proto, name, { value: wrapped, writable: true, configurable: true })
  }
}
tagSpyMatchers()

function pinToSatisfy(): void {
  const proto = Object.getPrototypeOf(expect(null)) as Record<string, unknown>
  const current = Object.getOwnPropertyDescriptor(proto, 'toSatisfy')
  if (!current || current.get) return // absent, or already pinned
  const ours = current.value as (...args: unknown[]) => unknown
  let builtin: ((...args: unknown[]) => unknown) | undefined
  const dispatch = function (this: unknown, ...args: unknown[]) {
    if (typeof args[0] === 'function' && builtin) return builtin.apply(this, args)
    noteAssertionTest(this)
    return ours.apply(this, args)
  }
  Object.defineProperty(proto, 'toSatisfy', {
    configurable: true,
    enumerable: current.enumerable,
    get: () => dispatch,
    set: (fn: (...args: unknown[]) => unknown) => {
      builtin = fn
    },
  })
}
pinToSatisfy()

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
