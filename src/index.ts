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

export { bootAgent, createAgentPool, testNameOf } from './fixtures.js'
export type { AgentPool, AgentPoolOptions } from './fixtures.js'
export { selectedAgentKind } from './config-runtime.js'
export { retry } from './retry.js'
export { converse } from './converse.js'
export type { Conversation, ConversationTurn, ConverseOptions, Responder } from './converse.js'
export { OpencodeAgent } from './agent/opencode.js'
export {
  AcpxAgent,
  acpxAgentFactory,
  acpxSpecFactory,
  bareModelFlag,
  type AcpxSpec,
} from './agent/acpx.js'
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
export { piAcpxSpec, renderPiModelsJson, piModelFlag } from './agent/pi.js'
export {
  openclawAcpxSpec,
  renderOpenclawJson,
  OPENCLAW_GATEWAY_PORT,
} from './agent/openclaw.js'
export type { Agent, AgentBootOptions, RunOptions } from './agent/types.js'
export {
  SkillHandle,
  setSkillDetector,
  detectSkillInvocations,
  reasoningReferenceDetector,
  skillFileReadDetector,
} from './skill.js'
// Trace parsers are named after the wire envelope they decode, not after an
// agent: three built-in agents speak ACP through acpx, opencode has its own part
// stream. There is deliberately no default decoder for a bring-your-own CLI —
// a wire shape cannot be guessed, and guessing it wrong yields an empty trace
// (TODO §IX.1) — so `registerCommandAgent` requires an explicit `parse`, and an
// ACP-speaking BYO agent registers through acpxSpecFactory instead.
export {
  parseOpencodePartTrace,
  parseAcpTrace,
  compactAcpStream,
  buildTrace,
  // Deprecated pre-0.2 aliases.
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
  SatisfyTarget,
  RetryOptions,
  RetryPolicy,
  JudgeResult,
  JudgeRecord,
} from './types.js'
export type { SkillDetector } from './skill.js'
