/**
 * agentfoo public entrypoint.
 *
 * Test authors import the vitest primitives (`test`, `expect`, `describe`, …)
 * from here rather than from vitest directly, so importing agentfoo also
 * registers the custom matchers (`toSatisfy`, `toHaveBeenCalled`) as a side
 * effect and there is a single, stable import surface (§2, §4).
 */

// Side effect: register custom matchers on vitest's expect.
import './matchers.js'

// Re-export vitest primitives unchanged (§4: "use vitest's native DSL").
export { test, expect, describe, it, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'

export { bootAgent } from './fixtures.js'
export { retry } from './retry.js'
export { HermesAgent } from './agent/hermes.js'
export { SkillHandle } from './skill.js'
export { parseTrace, buildTrace } from './trace.js'

export type {
  AgentConfig,
  AgentKind,
  AgentfooConfig,
  Runtime,
  Trace,
  TraceMessage,
  ToolCall,
  Rubric,
  RubricCriterion,
  SatisfyOptions,
  RetryOptions,
  RetryPolicy,
  JudgeResult,
} from './types.js'
