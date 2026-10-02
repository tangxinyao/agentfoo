import type { AgentKind } from '../types.js'
import type { Agent, AgentBootOptions } from './types.js'
import { OpencodeAgent } from './opencode.js'
import { acpxSpecFactory } from './acpx.js'
import { hermesAcpxSpec } from './hermes.js'
import { piAcpxSpec } from './pi.js'
import { openclawAcpxSpec } from './openclaw.js'

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
  /**
   * How to ask the agent binary its version. Only run under `--local`, where the
   * binary is whatever the host has installed rather than the Dockerfile's pin —
   * recorded in `report.json`, never compared or enforced (TODO §P1.5).
   */
  versionArgv?: string[]
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
    versionArgv: ['hermes', '--version'],
  }],
  ['opencode', {
    create: (opts) => new OpencodeAgent(opts),
    homeEnvVar: 'XDG_CONFIG_HOME',
    dockerfile: 'opencode.Dockerfile',
    versionArgv: ['opencode', '--version'],
  }],
  // pi & openclaw both ride the acpx adapter, but each has its own Dockerfile:
  // the underlying agents install differently and require different Node bases
  // (openclaw wants Node 24; pi is fine on 22).
  //
  // Neither uses ACPX_HOME as its home var. acpx only *spawns* the agent; it is
  // the agent itself that reads the provider config and discovers skills, under
  // its own state dir. Pointing that dir at the isolated home lands both exactly
  // where the runtime already writes them (`skills/<name>/SKILL.md` is
  // `RuntimeEnv.skillsPath` unchanged for both), and acpx keeps its own sessions
  // in the image's ACPX_HOME.
  ['pi', {
    create: acpxSpecFactory(piAcpxSpec),
    homeEnvVar: 'PI_CODING_AGENT_DIR',
    dockerfile: 'pi.Dockerfile',
    versionArgv: ['pi', '--version'],
  }],
  ['openclaw', {
    create: acpxSpecFactory(openclawAcpxSpec),
    homeEnvVar: 'OPENCLAW_STATE_DIR',
    dockerfile: 'openclaw.Dockerfile',
    versionArgv: ['openclaw', '--version'],
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
