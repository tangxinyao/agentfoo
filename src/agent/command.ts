import { join } from 'node:path'
import type { AgentConfig, Trace } from '../types.js'
import type { RuntimeEnv } from '../runtime/types.js'
import type { Agent, AgentBootOptions } from './types.js'
import { parseTrace } from '../trace.js'
import { resolveModelProvider } from './hermes.js'
import { SkillHandle } from '../skill.js'
import { preview, progress, withHeartbeat } from '../progress.js'
import { collectCredentials, readSkillName } from './shared.js'
import { registerAgent } from './registry.js'

/**
 * Everything one conversation turn needs to build its CLI invocation. Passed to
 * {@link CommandAgentDef.run}. The model/provider are pre-split (via the shared
 * {@link resolveModelProvider}) so a definition never re-parses a `provider/model`
 * string, and `sessionId` / `started` let it decide how to continue a session.
 */
export interface CommandRunContext {
  prompt: string
  config: AgentConfig
  /** Bare model id (prefix stripped), or undefined when unset. */
  model?: string
  /** Provider, from an explicit `config.provider` or the `model` prefix. */
  provider?: string
  /** Skill names preloaded so far, in load order. */
  skills: readonly string[]
  /** Session id captured from a previous turn via {@link CommandAgentDef.extractSessionId}. */
  sessionId?: string
  /** True once at least one turn has run in this session (for `-c`-style resume). */
  started: boolean
  /** Unique per-instance tag, e.g. for a `--source` flag. */
  sourceTag: string
  /** Isolated agent-home dir inside the runtime. */
  agentHome: string
  /** Where preloaded skills live inside the runtime. */
  skillsPath: string
}

/** Context for a definition's optional {@link CommandAgentDef.init} step. */
export interface CommandInitContext {
  config: AgentConfig
  model?: string
  provider?: string
  env: RuntimeEnv
  agentHome: string
}

/** Context for a definition's optional {@link CommandAgentDef.exportTrace} step. */
export interface CommandExportContext {
  env: RuntimeEnv
  /** Session id resolved from this turn's stdout via {@link CommandAgentDef.extractSessionId}. */
  sessionId?: string
  /** The run's raw stdout, in case the export derives from it. */
  stdout: string
  /** This instance's unique tag, e.g. for a `--source` session lookup. */
  sourceTag: string
  /** Credentials forwarded to the run exec, to reuse for the export exec. */
  credentialEnv: Record<string, string>
}

/**
 * Declarative description of how to drive a custom coding-agent CLI, so a
 * consumer can plug in a bring-your-own agent without implementing the whole
 * {@link Agent} interface (§7). The shared plumbing — skill/workspace loading,
 * per-test session reset, heartbeat, artifact capture — lives in
 * {@link CommandAgent}; a definition only supplies the CLI-specific bits.
 */
export interface CommandAgentDef {
  /** Build the argv for one conversation turn. The only required hook. */
  run(ctx: CommandRunContext): string[]
  /**
   * Parse the run's stdout into a normalized {@link Trace}. Defaults to
   * {@link parseTrace} (OpenAI-shaped jsonl); pass {@link parseOpencodeTrace} /
   * {@link parseAcpxTrace} or your own for a different envelope.
   */
  parse?(stdout: string): Trace
  /** Optional setup before the first run — e.g. write a config file into the home. */
  init?(ctx: CommandInitContext): void | Promise<void>
  /** Optional: capture a session id from stdout so later turns can continue it. */
  extractSessionId?(stdout: string): string | undefined
  /**
   * Optional: turn a completed run into the jsonl {@link parse} consumes, when the
   * trace is not on stdout. hermes, e.g., runs the turn then exports the saved
   * session separately (`hermes sessions export`). When omitted, the run's stdout
   * is parsed directly.
   */
  exportTrace?(ctx: CommandExportContext): Promise<string>
}

/**
 * Generic adapter that turns a {@link CommandAgentDef} into a full {@link Agent}.
 * It owns every concern shared across the built-in adapters (hermes / opencode /
 * acpx) — credential forwarding, one-time workspace seeding, dedup'd skill
 * preload, fresh-session-per-test boundaries, the run heartbeat, and per-turn
 * artifact capture — and delegates only the CLI-specific argv/parse/init/session
 * bits to the definition.
 */
export class CommandAgent implements Agent {
  private readonly env: RuntimeEnv
  private readonly config: AgentConfig
  private readonly sourceTag: string
  private readonly onTrace?: AgentBootOptions['onTrace']
  private readonly currentTest?: () => string | undefined
  private readonly credentialEnv: Record<string, string>

  private sessionId: string | undefined
  private started = false
  private workspaceLoaded = false
  private readonly loadedSkills = new Set<string>()
  private sessionTest: string | undefined
  readonly traces: Trace[] = []

  constructor(
    private readonly def: CommandAgentDef,
    opts: AgentBootOptions,
  ) {
    this.env = opts.env
    this.config = opts.config
    this.sourceTag = opts.sourceTag
    this.onTrace = opts.onTrace
    this.currentTest = opts.currentTest
    this.credentialEnv = collectCredentials(opts.config.passEnv)
  }

  get workspacePath(): string {
    return this.env.workspacePath
  }

  async init(): Promise<void> {
    if (!this.def.init) return
    const { model, provider } = resolveModelProvider(this.config)
    await this.def.init({
      config: this.config,
      model,
      provider,
      env: this.env,
      agentHome: this.env.agentHome,
    })
  }

  async loadSkill(hostPath: string): Promise<SkillHandle> {
    const name = await readSkillName(hostPath)
    if (!this.loadedSkills.has(name)) {
      await this.env.copyDir(hostPath, join(this.env.skillsPath, name))
      this.loadedSkills.add(name)
    }
    return new SkillHandle(name, hostPath, () => this.traces)
  }

  async loadWorkspace(hostPath: string): Promise<string> {
    if (this.workspaceLoaded) {
      throw new Error(
        'loadWorkspace may only be called once per agent instance (§4): merge sources into a single fixture directory instead of layering.',
      )
    }
    await this.env.copyDir(hostPath, this.env.workspacePath)
    this.workspaceLoaded = true
    return this.env.workspacePath
  }

  async run(prompt: string): Promise<Trace> {
    const test = this.currentTest?.()
    if (test !== this.sessionTest) {
      this.reset()
      this.sessionTest = test
    }
    const { model, provider } = resolveModelProvider(this.config)
    const argv = this.def.run({
      prompt,
      config: this.config,
      model,
      provider,
      skills: [...this.loadedSkills],
      sessionId: this.sessionId,
      started: this.started,
      sourceTag: this.sourceTag,
      agentHome: this.env.agentHome,
      skillsPath: this.env.skillsPath,
    })
    const { stdout, stderr, exitCode } = await withHeartbeat(
      `${argv[0] ?? 'command'} run: "${preview(prompt)}"`,
      () => this.env.exec(argv, { env: this.credentialEnv }),
    )
    if (exitCode !== 0) {
      throw new Error(`${argv[0] ?? 'command'} exited ${exitCode}\n${stderr || stdout}`)
    }

    this.sessionId = this.def.extractSessionId?.(stdout) ?? this.sessionId
    this.started = true

    const jsonl = this.def.exportTrace
      ? await this.def.exportTrace({
          env: this.env,
          sessionId: this.sessionId,
          stdout,
          sourceTag: this.sourceTag,
          credentialEnv: this.credentialEnv,
        })
      : stdout
    const trace = (this.def.parse ?? parseTrace)(jsonl)
    progress(`  trace: ${trace.messages.length} messages, ${trace.toolCalls.length} tool calls`)
    this.traces.push(trace)
    this.onTrace?.({ trace, sessionJsonl: jsonl })
    return trace
  }

  reset(): void {
    this.sessionId = undefined
    this.started = false
  }

  async teardown(): Promise<void> {
    await this.env.teardown()
  }
}

/** Factory binding a {@link CommandAgentDef} into an {@link AgentBootOptions} constructor. */
export function commandAgentFactory(def: CommandAgentDef): (opts: AgentBootOptions) => CommandAgent {
  return (opts) => new CommandAgent(def, opts)
}

/** A {@link CommandAgentDef} plus the registry metadata {@link registerCommandAgent} needs. */
export interface CommandAgentRegistration extends CommandAgentDef {
  /**
   * Env var the runtime sets to the agent's isolated home on every exec (like
   * hermes `HERMES_HOME`). Defaults to `AGENT_HOME`; only matters if the CLI
   * reads a home dir for its config/session store.
   */
  homeEnvVar?: string
  /**
   * Basename of a Dockerfile bundled under `dockers/` for this agent. Custom
   * agents usually set `image` or `dockerfile` in their agentfoo config instead;
   * defaults to `<kind>.Dockerfile`, which — being absent from the package —
   * makes `runtime:'docker'` surface the actionable "set an image/dockerfile or
   * run --local" error rather than silently misbuilding.
   */
  dockerfile?: string
}

/**
 * Register a custom agent driven by a plain CLI, in one call, without writing an
 * adapter class (§7). This is the recommended entry point for testing a
 * bring-your-own agent:
 *
 * ```ts
 * registerCommandAgent('mycli', {
 *   homeEnvVar: 'MYCLI_HOME',
 *   run: ({ prompt, model, sessionId }) => [
 *     'mycli', 'chat', prompt, '--json',
 *     ...(model ? ['--model', model] : []),
 *     ...(sessionId ? ['--resume', sessionId] : []),
 *   ],
 *   extractSessionId: (out) => out.match(/session:\s*(\S+)/)?.[1],
 *   // parse defaults to parseTrace (OpenAI-shaped jsonl)
 * })
 * ```
 *
 * Then a fixture boots it the same as any built-in: `await bootAgent('mycli')`.
 * Call this once at import time, before that boot runs.
 */
export function registerCommandAgent(kind: string, reg: CommandAgentRegistration): void {
  const { homeEnvVar = 'AGENT_HOME', dockerfile = `${kind}.Dockerfile`, ...def } = reg
  registerAgent(kind, { create: commandAgentFactory(def), homeEnvVar, dockerfile })
}
