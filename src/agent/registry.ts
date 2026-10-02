import type { AgentKind } from '../types.js'
import type { Agent, AgentBootOptions } from './types.js'
import { OpencodeAgent } from './opencode.js'
import { acpxAgentFactory, acpxSpecFactory } from './acpx.js'
import { hermesAcpxSpec } from './hermes.js'

/**
 * Everything the fixture + runtime layers need to boot one agent kind, without
 * hard-coding any single agent. Adding an agent is one entry here (plus its
 * adapter and Dockerfile).
 */
export interface AgentSpec {
  /** Construct the adapter for a booted runtime env. */
  create(opts: AgentBootOptions): Agent
  /**
   * Host-dir env var the runtime sets on every exec so the CLI finds its
   * isolated config/session home (hermes: HERMES_HOME; opencode reads config
   * under XDG_CONFIG_HOME/opencode).
   */
  homeEnvVar: string
  /** Basename of the bundled Dockerfile under `dockers/` for this agent. */
  dockerfile: string
}

const REGISTRY = new Map<string, AgentSpec>([
  // hermes rides the shared acpx adapter via the `--agent 'hermes acp'` escape
  // hatch, isolating per test by cwd (TODO §VI.4). HERMES_HOME points at the
  // isolated home so hermes reads the config.yaml hermesAcpxSpec.init writes there
  // (provider / base_url / memory-off); the key stays off-disk via passEnv.
  ['hermes', {
    create: acpxSpecFactory(hermesAcpxSpec),
    homeEnvVar: 'HERMES_HOME',
    dockerfile: 'hermes.Dockerfile',
  }],
  ['opencode', {
    create: (opts) => new OpencodeAgent(opts),
    homeEnvVar: 'XDG_CONFIG_HOME',
    dockerfile: 'opencode.Dockerfile',
  }],
  // pi & openclaw share the acpx adapter (differing only by the ACP agent name),
  // but each has its own Dockerfile: the underlying agents install differently
  // and require different Node bases (openclaw wants Node 24; pi is fine on 22).
  ['pi', {
    create: acpxAgentFactory('pi'),
    homeEnvVar: 'ACPX_HOME',
    dockerfile: 'pi.Dockerfile',
  }],
  ['openclaw', {
    create: acpxAgentFactory('openclaw'),
    homeEnvVar: 'ACPX_HOME',
    dockerfile: 'openclaw.Dockerfile',
  }],
])

/**
 * Register (or override) an agent kind at runtime so a consumer can test a
 * bring-your-own agent without forking agentfoo (§7). Call it once at import
 * time — from an agentfoo `setupFiles` module or the top of a test file — before
 * any `bootAgent(kind)` for that kind runs. Re-registering an existing kind
 * replaces its spec. For the common "I just have a CLI" case, prefer the
 * higher-level `registerCommandAgent` ({@link file://./command.ts}), which builds
 * the spec for you.
 */
export function registerAgent(kind: string, spec: AgentSpec): void {
  REGISTRY.set(kind, spec)
}

/** Look up an agent kind's spec, or throw a helpful error listing valid kinds. */
export function agentSpec(kind: AgentKind): AgentSpec {
  const spec = REGISTRY.get(kind)
  if (!spec) {
    throw new Error(
      `Unknown agent kind "${kind}". Registered kinds: ${[...REGISTRY.keys()].join(', ')}. ` +
        'Register a custom agent with registerAgent()/registerCommandAgent() before booting it.',
    )
  }
  return spec
}
