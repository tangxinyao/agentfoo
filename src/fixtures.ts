import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { AgentConfig, AgentKind } from './types.js'
import type { Runtime, RuntimeEnv } from './runtime/types.js'
import { LocalRuntime } from './runtime/local.js'
import { DockerRuntime, bundledDockerfile } from './runtime/docker.js'
import type { Agent } from './agent/types.js'
import { agentSpec, type AgentSpec } from './agent/registry.js'
import { loadConfig, resolveAgentConfig, selectedAgentKind } from './config-runtime.js'
import { recordAgentVersion, recordTestArtifacts } from './artifacts.js'
import { progress } from './progress.js'
import { resolveSkillOverride } from './agent/shared.js'

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
  return boot(explicitKind, override, globalTestName)
}

/**
 * The running test's name from vitest's *global* expect state. Correct as long as
 * a worker runs one test at a time — the default. Under `test.concurrent` it names
 * whichever test started last, which is why {@link createAgentPool} binds each
 * checked-out agent to its test explicitly instead.
 */
function globalTestName(): string | undefined {
  return expect.getState().currentTestName ?? undefined
}

async function boot(
  explicitKind: AgentKind | undefined,
  override: AgentConfig,
  testName: () => string | undefined,
): Promise<Agent> {
  const kind = explicitKind ?? selectedAgentKind()
  const spec = agentSpec(kind)
  const config = resolveAgentConfig(kind, override)
  const runtime = selectRuntime(config, spec)
  const id = `${kind}-${randomUUID().slice(0, 8)}`
  const env = await runtime.boot(id, { homeEnvVar: spec.homeEnvVar })
  if (runtime.kind === 'local' && spec.versionArgv) await noteLocalVersion(kind, spec.versionArgv, env)

  let turn = 0
  const agent = spec.create({
    env,
    config,
    sourceTag: `agentfoo-${id}`,
    // Lets the adapter start a fresh session at each test boundary (§4) while
    // staying vitest-agnostic itself — the vitest dependency lives here.
    currentTest: testName,
    onTrace: ({ trace, sessionJsonl }) => {
      turn++
      try {
        recordTestArtifacts(testName() ?? 'unknown', { trace, sessionJsonl, turn })
      } catch {
        // Artifact writing must never fail a test.
      }
    },
  })
  // Candidate skills (`agentfoo optimize`) replace the real dir here, once for
  // every adapter, so specs keep loading the path they always load.
  const loadSkill = agent.loadSkill.bind(agent)
  agent.loadSkill = async (hostPath, opts) => loadSkill(await resolveSkillOverride(hostPath), opts)
  await agent.init()
  return agent
}

/** The subset of a vitest test context {@link testNameOf} needs. */
interface TaskLike {
  name: string
  suite?: (TaskLike & { filepath?: string }) | undefined
}

/**
 * A test's name the way vitest builds `currentTestName` ("describe > it", no file
 * part) — the key judge records and artifact directories are filed under. Derived
 * from the test's own task object, so it stays correct under `test.concurrent`.
 */
export function testNameOf(task: TaskLike): string {
  const names = [task.name]
  for (let s = task.suite; s && !('filepath' in s && s.filepath); s = s.suite) names.unshift(s.name)
  return names.join(' > ')
}

export interface AgentPoolOptions {
  /**
   * Upper bound on live agents (containers). Defaults to the config's
   * `concurrency`. Size it to host memory: a pi container is ~270MB, openclaw ~850MB.
   */
  size?: number
  /** Pin the agent kind; omit to take it from `-a/--agent` like {@link bootAgent}. */
  kind?: AgentKind
  override?: AgentConfig
}

export interface AgentPool {
  /**
   * Check out an agent for one test, booting a new one while under `size`,
   * otherwise waiting for a release. The agent is bound to `testName` (use
   * {@link testNameOf}) for session isolation and artifact filing until released.
   */
  acquire(testName: string): Promise<Agent>
  release(agent: Agent): void
  /** Tear down every agent the pool booted. */
  teardown(): Promise<void>
}

/**
 * A bounded set of agents shared by concurrently running tests (TODO §P2.5).
 *
 * One agent per spec file means a 28-case dataset runs one case at a time. With a
 * pool, `test.concurrent` cases each borrow their own agent — and the pool binds
 * the borrower's name to it, because the global expect state that
 * {@link bootAgent} relies on names only the most recently started test once
 * tests overlap. Skills loaded into a pooled agent stay loaded across borrowers
 * (`loadSkill` dedupes by name), as with a file-scoped agent.
 *
 * ```ts
 * pool: [async ({}, use) => {
 *   const pool = createAgentPool({ size: 2 })
 *   await use(pool)
 *   await pool.teardown()
 * }, { scope: 'file' }],
 * agent: async ({ pool, task }, use) => {
 *   const agent = await pool.acquire(testNameOf(task))
 *   await use(agent)
 *   pool.release(agent)
 * },
 * ```
 *
 * Inside concurrent tests, assert with the context's `expect` (`async ({ expect }) =>`),
 * as vitest requires for concurrency — the judge records its test from that.
 */
export function createAgentPool(opts: AgentPoolOptions = {}): AgentPool {
  const size = opts.size ?? loadConfig().concurrency
  if (!(size >= 1)) throw new Error(`createAgentPool: size must be >= 1, got ${size}`)
  const all: Agent[] = []
  const idle: Agent[] = []
  const boundTo = new Map<Agent, { name: string | undefined }>()
  const waiters: Array<(a: Agent) => void> = []
  let booting = 0

  const checkout = (agent: Agent, testName: string): Agent => {
    boundTo.get(agent)!.name = testName
    return agent
  }

  return {
    async acquire(testName) {
      const free = idle.pop()
      if (free) return checkout(free, testName)
      if (all.length + booting < size) {
        booting++
        const binding: { name: string | undefined } = { name: testName }
        try {
          const agent = await boot(opts.kind, opts.override ?? {}, () => binding.name)
          all.push(agent)
          boundTo.set(agent, binding)
          return agent
        } finally {
          booting--
        }
      }
      const agent = await new Promise<Agent>((resolve) => waiters.push(resolve))
      return checkout(agent, testName)
    },
    release(agent) {
      const binding = boundTo.get(agent)
      if (!binding) throw new Error('createAgentPool: release() of an agent this pool did not hand out')
      binding.name = undefined
      const next = waiters.shift()
      if (next) next(agent)
      else idle.push(agent)
    },
    async teardown() {
      await Promise.all(all.map((a) => a.teardown()))
      all.length = 0
      idle.length = 0
    },
  }
}

/**
 * Under `--local` the agent is whatever the host has installed, not the
 * Dockerfile's pin — and the two drift (pi was 9 minors apart once, with a real
 * bug in the gap). Record the version; never compare or enforce it.
 */
async function noteLocalVersion(kind: string, argv: string[], env: RuntimeEnv): Promise<void> {
  try {
    const { stdout, stderr, exitCode } = await env.exec(argv)
    const version = (exitCode === 0 ? stdout || stderr : `unknown (exit ${exitCode})`).trim().split('\n')[0]
    recordAgentVersion(kind, version)
    progress(`  local ${kind}: ${version}`)
  } catch {
    // version reporting must never break a run
  }
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
