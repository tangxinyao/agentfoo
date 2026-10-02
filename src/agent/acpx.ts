import { join } from 'node:path'
import type { AgentConfig, Trace } from '../types.js'
import type { RuntimeEnv } from '../runtime/types.js'
import type { Agent, AgentBootOptions } from './types.js'
import { compactAcpStream, parseAcpTrace } from '../trace.js'
import { SkillHandle } from '../skill.js'
import type { SkillDetector } from '../skill.js'
import { preview, progress, withHeartbeat } from '../progress.js'
import { collectCredentials, readSkillName } from './shared.js'
import { resolveModelProvider } from './hermes.js'

/**
 * How to reach one ACP agent through the acpx headless client. Either a built-in
 * acpx registry name (`agent`, e.g. `pi`/`openclaw` — acpx's first positional) or
 * a raw launch command for an agent acpx does not ship (`launchCommand`, driven
 * via `acpx --agent '<cmd>'`, the documented escape hatch — this is how hermes
 * runs, `launchCommand: 'hermes acp'`).
 */
export interface AcpxSpec {
  /** acpx built-in registry name (acpx's first positional arg), e.g. `pi`. */
  agent?: string
  /** Raw ACP server command for an unlisted agent: `acpx --agent '<cmd>'`. */
  launchCommand?: string
  /** Human label for logs / errors. Defaults to `agent ?? launchCommand`. */
  label?: string
  /**
   * Value for acpx's top-level `--model <id>` flag on each turn, or undefined to
   * omit it. acpx forwards the string verbatim, so the accepted spelling is the
   * underlying agent's own: pi wants `provider/model` because its `models.json`
   * can shadow a built-in id, whereas an agent with one namespace takes a bare
   * id ({@link bareModelFlag}). Leave unset for agents configured entirely
   * through their own home file — hermes takes model/provider/base_url from the
   * `config.yaml` its {@link init} writes, and acpx's generic `--model` has
   * nowhere to put a base_url anyway (TODO §V.4).
   */
  modelFlag?(config: AgentConfig): string | undefined
  /**
   * Seed the underlying agent's own home before the first run — e.g. write
   * hermes' `config.yaml` into HERMES_HOME. Runs once per boot, before any
   * session is created.
   */
  init?(ctx: { env: RuntimeEnv; config: AgentConfig; credentialEnv: Record<string, string> }): Promise<void>
  /**
   * This agent's skill-firing signal (§5). ACP normalizes the *transport*, not
   * what a skill activation looks like: hermes preloads skills and only names
   * them in reasoning ({@link reasoningReferenceDetector}), while an agent with
   * a native skill tool surfaces a real tool call. Leave unset to use the
   * built-in {@link detectSkillInvocations} guess.
   */
  skillDetector?: SkillDetector
  /**
   * Extra context to append when an acpx invocation fails. acpx reports only
   * what it saw over the wire, which for an agent that is really a *bridge* to
   * a separate daemon is close to useless — openclaw's Gateway dying mid-turn
   * surfaces as `agent needs reconnect`, naming neither the daemon nor a reason.
   * This hook lets the spec that started such a process go read its log.
   * Best-effort: whatever it throws is ignored, so a broken diagnostic can never
   * mask the failure it was meant to explain.
   */
  diagnose?(ctx: { env: RuntimeEnv }): Promise<string | undefined>
}

/**
 * Adapter for ACP-protocol coding agents driven through the acpx headless client
 * (§7). One command surface covers every ACP agent — pi and openclaw as built-in
 * names, hermes via the `--agent 'hermes acp'` escape hatch — parameterized by an
 * {@link AcpxSpec}.
 *
 * **Isolation is cwd-scoped, not named-session.** acpx keys a saved session to
 * the working directory by default (`-s <name>` only opts into a *named* session
 * "instead of the cwd default"), and `-s` is rejected on the `--agent` path, so a
 * named-session design cannot drive hermes (TODO §V.2 #2). Instead, every test
 * shares this instance's workspace as `--cwd`, and a test boundary runs
 * `sessions new` to start a fresh conversation for that cwd — verified green
 * against real hermes 0.18.2 + acpx 0.12.1 (TODO §VI.4):
 *
 * ```
 * acpx <target> --cwd <ws> sessions new                          # once per test
 * acpx <target> --cwd <ws> --approve-all --format json "<prompt>"  # each turn → newest cwd session
 * ```
 *
 * The per-turn `--format json` stdout is the ACP `session/update` NDJSON stream
 * {@link parseAcpTrace} normalizes.
 *
 * All three built-in routes are probe-verified against real binaries: hermes via
 * `--agent 'hermes acp'`, pi and openclaw as built-in names — including the
 * top-level flag positions and each agent's own provider wiring. They differ in
 * `--model`: pi needs it provider-qualified, hermes and openclaw take the model
 * from their own config file and must not be passed it at all.
 */
export class AcpxAgent implements Agent {
  private readonly env: RuntimeEnv
  private readonly config: AgentConfig
  private readonly onTrace?: AgentBootOptions['onTrace']
  private readonly currentTest?: () => string | undefined
  private readonly credentialEnv: Record<string, string>
  private readonly label: string

  private hasSession = false
  private sessionTest: string | undefined
  private workspaceLoaded = false
  private readonly loadedSkills = new Set<string>()
  readonly traces: Trace[] = []

  constructor(
    /** Which ACP agent to drive and how to reach it. */
    private readonly spec: AcpxSpec,
    opts: AgentBootOptions,
  ) {
    this.env = opts.env
    this.config = opts.config
    this.onTrace = opts.onTrace
    this.currentTest = opts.currentTest
    this.credentialEnv = collectCredentials(opts.config.passEnv)
    this.label = spec.label ?? spec.agent ?? spec.launchCommand ?? 'acpx'
  }

  get workspacePath(): string {
    return this.env.workspacePath
  }

  /** Seed the underlying agent's home (e.g. hermes config.yaml). No session yet. */
  async init(): Promise<void> {
    if (this.spec.init) {
      await this.spec.init({ env: this.env, config: this.config, credentialEnv: this.credentialEnv })
    }
  }

  async loadSkill(hostPath: string): Promise<SkillHandle> {
    const name = await readSkillName(hostPath)
    if (!this.loadedSkills.has(name)) {
      await this.env.copyDir(hostPath, join(this.env.skillsPath, name))
      this.loadedSkills.add(name)
    }
    return new SkillHandle(name, hostPath, () => this.traces, this.spec.skillDetector)
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
    await this.ensureSession()
    const argv = this.buildRunArgv(prompt)
    const { stdout, stderr, exitCode } = await withHeartbeat(
      `acpx ${this.label} run: "${preview(prompt)}"`,
      () => this.env.exec(argv, { env: this.credentialEnv }),
    )
    if (exitCode !== 0) {
      throw new Error(await this.failure(`exited ${exitCode}`, stderr || stdout))
    }

    // Drop superseded partial-input frames before anything else looks at the
    // stream, so the trace, `trace.raw` and the archived artifact all derive
    // from the same bytes. An agent that streams tool arguments restates the
    // whole input per token: one real pi turn wrote 103.7MB of stdout for a
    // single file (§compactAcpStream). No-op for an agent that doesn't.
    const session = compactAcpStream(stdout)
    if (session.length < stdout.length) {
      progress(`  compacted stream: ${mib(stdout.length)} → ${mib(session.length)}`)
    }

    const trace = parseAcpTrace(session)
    progress(`  trace: ${trace.messages.length} messages, ${trace.toolCalls.length} tool calls`)
    this.traces.push(trace)
    this.onTrace?.({ trace, sessionJsonl: session })
    return trace
  }

  /** Drop the current session so the next run() starts a fresh cwd conversation. */
  reset(): void {
    this.hasSession = false
  }

  async teardown(): Promise<void> {
    await this.env.teardown()
  }

  /**
   * Start a fresh cwd session at each test boundary (or after {@link reset}). acpx
   * won't route a bare prompt until a session exists for the cwd ("⚠ No acpx
   * session found"), and re-running `sessions new` in the same cwd yields a fresh,
   * empty session that subsequent prompts adopt — the isolation primitive (§VI.3).
   */
  private async ensureSession(): Promise<void> {
    const test = this.currentTest?.()
    if (this.hasSession && test === this.sessionTest) return
    const argv = [...this.acpxFrame(), 'sessions', 'new']
    const { stdout, stderr, exitCode } = await this.env.exec(argv, { env: this.credentialEnv })
    if (exitCode !== 0) {
      throw new Error(await this.failure(`sessions new failed (${exitCode})`, stderr || stdout))
    }
    this.sessionTest = test
    this.hasSession = true
  }

  /**
   * The `acpx … --cwd <ws>` prefix shared by every invocation, with the agent
   * target and all top-level options placed *before* any subcommand (commander
   * resolves globals before the command). For `launchCommand`, `--agent '<cmd>'`
   * is itself the target; for a built-in `agent`, its name is the subcommand.
   */
  private acpxFrame(extraGlobals: string[] = []): string[] {
    const globals = this.spec.launchCommand
      ? ['--agent', this.spec.launchCommand, '--cwd', this.env.workspacePath, ...extraGlobals]
      : ['--cwd', this.env.workspacePath, ...extraGlobals]
    const agentToken = this.spec.launchCommand ? [] : [this.spec.agent as string]
    return ['acpx', ...globals, ...agentToken]
  }

  /**
   * Build the message for a failed acpx invocation, enriched with whatever
   * {@link AcpxSpec.diagnose} can add. The diagnostic is strictly best-effort:
   * an agent is already failing here, and a second failure while explaining the
   * first would replace a real error with a spurious one.
   */
  private async failure(what: string, output: string): Promise<string> {
    let extra: string | undefined
    try {
      extra = await this.spec.diagnose?.({ env: this.env })
    } catch {
      // ignored on purpose — see above
    }
    return `acpx ${this.label} ${what}\n${output}${extra ? `\n\n${extra}` : ''}`
  }

  private buildRunArgv(prompt: string): string[] {
    const globals = ['--approve-all', '--format', 'json']
    const model = this.spec.modelFlag?.(this.config)
    if (model) globals.push('--model', model)
    const argv = [...this.acpxFrame(globals), prompt]
    if (this.config.extraArgs) argv.push(...this.config.extraArgs)
    return argv
  }
}

/** Byte count as MiB, for the one progress line that reports a size. */
function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** Bind an {@link AcpxSpec} into an {@link AgentBootOptions} constructor. */
export function acpxSpecFactory(spec: AcpxSpec): (opts: AgentBootOptions) => AcpxAgent {
  return (opts) => new AcpxAgent(spec, opts)
}

/** The model id with any `provider/` prefix stripped — acpx's plain `--model`. */
export function bareModelFlag(config: AgentConfig): string | undefined {
  return resolveModelProvider(config).model
}

/**
 * Factory for a built-in acpx agent name with no provider config of its own: the
 * model is selected through acpx's top-level `--model` flag and there is no
 * home-file init. No built-in agent still uses this — both pi and openclaw
 * outgrew it (`piAcpxSpec`, `openclawAcpxSpec`), because reaching a custom
 * endpoint needs a `base_url` acpx has no flag for. It stays exported as the
 * one-liner for a bring-your-own ACP agent that a built-in provider already
 * covers; anything else wants a full {@link AcpxSpec}.
 */
export function acpxAgentFactory(acpAgent: string): (opts: AgentBootOptions) => AcpxAgent {
  return acpxSpecFactory({ agent: acpAgent, label: acpAgent, modelFlag: bareModelFlag })
}
