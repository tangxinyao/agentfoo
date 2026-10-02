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
export { selectedAgentKind } from './config-runtime.js'
export { retry } from './retry.js'
export { OpencodeAgent } from './agent/opencode.js'
export { AcpxAgent, acpxAgentFactory, acpxSpecFactory, type AcpxSpec } from './agent/acpx.js'
export { registerAgent, type AgentSpec } from './agent/registry.js'
export {
  CommandAgent,
  commandAgentFactory,
  registerCommandAgent,
} from './agent/command.js'
export type {
  CommandAgentDef,
  CommandAgentRegistration,
  CommandRunContext,
  CommandInitContext,
  CommandExportContext,
} from './agent/command.js'
export { hermesAcpxSpec, resolveModelProvider, renderConfigYaml } from './agent/hermes.js'
export type { Agent, AgentBootOptions } from './agent/types.js'
export { SkillHandle, setSkillDetector, detectSkillInvocations, reasoningReferenceDetector } from './skill.js'
// Trace parsers are named after the wire envelope they decode, not after an
// agent: four built-in agents map onto three envelopes (hermes/pi/openclaw all
// speak ACP), and a bring-your-own CLI may reuse any of them.
export {
  parseOpenAiChatTrace,
  parseOpencodePartTrace,
  parseAcpTrace,
  buildTrace,
  // Deprecated pre-0.2 aliases.
  parseTrace,
  parseOpencodeTrace,
  parseAcpxTrace,
} from './trace.js'

export type {
  AgentConfig,
  AgentKind,
  KnownAgentKind,
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
export type { SkillDetector } from './skill.js'
