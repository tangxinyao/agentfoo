import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { AgentConfig, AgentKind } from './types.js'
import type { Runtime } from './runtime/types.js'
import { LocalRuntime } from './runtime/local.js'
import { DockerRuntime } from './runtime/docker.js'
import { HermesAgent } from './agent/hermes.js'
import { resolveAgentConfig } from './config-runtime.js'
import { recordTestArtifacts } from './artifacts.js'

/**
 * Boot an agent instance for a fixture (§4). Test authors call this inside a
 * `test.extend({ hermes: async ({}, use) => { const a = await bootAgent('hermes'); ... } })`
 * fixture — agentfoo does not impose a fixed fixture name.
 *
 * It resolves the effective config (config defaults ← per-test override, §6),
 * selects the runtime (docker default, local via `runtime:'local'` or the
 * `--local` CLI flag, §3), wires per-turn artifact capture (§9), and writes the
 * hermes config into the isolated agent home before returning.
 */
export async function bootAgent(kind: AgentKind, override: AgentConfig = {}): Promise<HermesAgent> {
  if (kind !== 'hermes') {
    throw new Error(`Unknown agent kind "${kind}". v1 only supports "hermes" (§7).`)
  }
  const config = resolveAgentConfig(kind, override)
  const runtime = selectRuntime(config)
  const id = `${kind}-${randomUUID().slice(0, 8)}`
  const env = await runtime.boot(id)

  let turn = 0
  const agent = new HermesAgent({
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

function selectRuntime(config: AgentConfig): Runtime {
  const forceLocal = process.env.AGENTFOO_FORCE_LOCAL === '1'
  if (forceLocal || config.runtime === 'local') return new LocalRuntime()

  if (!config.image && !config.dockerfile) {
    throw new Error(
      'runtime "docker" requires an image or a dockerfile. Set agents.hermes.dockerfile ' +
        '(or .image) in agentfoo.config.ts, or run with --local to use the installed hermes ' +
        'binary (dev only, not CI-safe).',
    )
  }
  return new DockerRuntime({
    image: config.image,
    dockerfile: config.dockerfile,
    buildContext: config.buildContext,
  })
}
