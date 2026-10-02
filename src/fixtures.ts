import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { AgentConfig, AgentKind } from './types.js'
import type { Runtime } from './runtime/types.js'
import { LocalRuntime } from './runtime/local.js'
import { DockerRuntime, bundledDockerfile } from './runtime/docker.js'
import type { Agent } from './agent/types.js'
import { agentSpec, type AgentSpec } from './agent/registry.js'
import { resolveAgentConfig, selectedAgentKind } from './config-runtime.js'
import { recordTestArtifacts } from './artifacts.js'

/**
 * Boot an agent instance for a fixture (§4). Test authors call this inside a
 * `test.extend({ agent: async ({}, use) => { const a = await bootAgent(); ... } })`
 * fixture — agentfoo does not impose a fixed fixture name.
 *
 * It looks up the agent kind in the registry, resolves the effective config
 * (config defaults ← per-test override, §6), selects the runtime (docker
 * default, local via `runtime:'local'` or the `--local` CLI flag, §3), wires
 * per-turn artifact capture (§9), and writes the agent config into its isolated
 * home before returning.
 *
 * **Omit `kind` to make the suite agent-selectable.** With no kind the agent comes
 * from {@link selectedAgentKind} — the CLI's `-a/--agent`, else the sole configured
 * agent — so the same specs can run against a different agent without an edit:
 *
 * ```
 * agentfoo run -a opencode
 * ```
 *
 * Passing a kind explicitly pins the fixture to that agent and ignores `-a`, which
 * is what you want for a spec that is genuinely about one agent's behaviour.
 */
export async function bootAgent(override?: AgentConfig): Promise<Agent>
export async function bootAgent(kind: AgentKind, override?: AgentConfig): Promise<Agent>
export async function bootAgent(
  kindOrOverride?: AgentKind | AgentConfig,
  maybeOverride: AgentConfig = {},
): Promise<Agent> {
  const explicitKind = typeof kindOrOverride === 'string' ? kindOrOverride : undefined
  const override = typeof kindOrOverride === 'object' ? kindOrOverride : maybeOverride
  const kind = explicitKind ?? selectedAgentKind()
  const spec = agentSpec(kind)
  const config = resolveAgentConfig(kind, override)
  const runtime = selectRuntime(config, spec)
  const id = `${kind}-${randomUUID().slice(0, 8)}`
  const env = await runtime.boot(id, { homeEnvVar: spec.homeEnvVar })

  let turn = 0
  const agent = spec.create({
    env,
    config,
    sourceTag: `agentfoo-${id}`,
    // Lets the adapter start a fresh session at each test boundary (§4) while
    // staying vitest-agnostic itself — the vitest dependency lives here.
    currentTest: () => expect.getState().currentTestName ?? undefined,
    onTrace: ({ trace, sessionJsonl }) => {
      turn++
      const testName = expect.getState().currentTestName ?? 'unknown'
      try {
        recordTestArtifacts(testName, { trace, sessionJsonl, turn })
      } catch {
        // Artifact writing must never fail a test.
      }
    },
  })
  await agent.init()
  return agent
}

function selectRuntime(config: AgentConfig, spec: AgentSpec): Runtime {
  const forceLocal = process.env.AGENTFOO_FORCE_LOCAL === '1'
  if (forceLocal || config.runtime === 'local') return new LocalRuntime()

  // No image/dockerfile configured is fine as long as the package ships this
  // agent's default Dockerfile — DockerRuntime falls back to it. Only error when
  // that bundle is also missing, so the message stays actionable.
  if (!config.image && !config.dockerfile && !bundledDockerfile(spec.dockerfile)) {
    throw new Error(
      'runtime "docker" requires an image or a dockerfile, and the bundled default ' +
        `Dockerfile (${spec.dockerfile}) could not be found. Set the agent's dockerfile ` +
        '(or .image) in agentfoo.config.ts, or run with --local to use the installed ' +
        'agent binary (dev only, not CI-safe).',
    )
  }
  return new DockerRuntime({
    image: config.image,
    dockerfile: config.dockerfile,
    buildContext: config.buildContext,
    bundledDockerfileName: spec.dockerfile,
  })
}
