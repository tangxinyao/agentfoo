import { join } from 'node:path'
import type { AgentConfig, Trace } from '../types.js'
import type { RuntimeEnv } from '../runtime/types.js'
import type { Agent, AgentBootOptions } from './types.js'
import { compactAcpStream, parseAcpTrace } from '../trace.js'
import { SkillHandle } from '../skill.js'
import type { SkillDetector } from '../skill.js'
import { preview, progress, withHeartbeat } from '../progress.js'
import { collectCredentials, readSkillBody, readSkillName } from './shared.js'
import { resolveModelProvider } from './hermes.js'

/**
 * acpx version pinned into `dockers/{hermes,pi,openclaw}.Dockerfile` — kept as
 * a linked comment rather than read from the Dockerfile (no build-time wiring
 * for one shared constant is worth adding), but the two must be bumped
 * together.
 */
const PINNED_ACPX_VERSION = '0.12.1'

/**
 * `--ttl` (seconds) passed on every invocation for an {@link AcpxSpec.isolatePerTest}
 * agent, real-machine confirmed necessary (TODO §P0/§P1.5): acpx's queue-owner
 * setsid-detaches into its own session (`ps` shows `PPID=1`, `SID==PGID==PID`),
 * so `LocalEnv.teardown`'s `kill(-pid)` can never reach it — the only lever that
 * actually bounds its lifetime is acpx's own idle TTL, not a signal from us. The
 * default is 300s; harmless for the *shared* per-file queue-owner pi/openclaw use
 * (one to reclaim per file), but isolatePerTest spins up a brand-new queue-owner
 * *per test*, so leaving the default meant every test in a run left its own idle
 * hermes process resident for up to 5 minutes — real regression, observed as
 * several live hermes venvs stacked at once after a single `--local` run. A
 * queue-owner here is never reused past its own test (a new test always gets a
 * new `--cwd`), so shortening its idle window costs nothing — it only needs to
 * outlive the gap between two run() calls *within* the same test.
 */
const ISOLATED_QUEUE_OWNER_TTL_SECONDS = 30

/**
 * The `[binary, ...prefixArgs]` to invoke acpx with, resolved once per
 * {@link AcpxAgent} instance and memoized (TODO §P1.5 #3). Docker images bake
 * `acpx` onto PATH at build time, so the probe there resolves immediately; a
 * bare host install has no such guarantee — this repo's own dev box doesn't
 * have it on PATH — so `--local` falls back to a version-pinned `npx`, the
 * same escape hatch pi's own adapter already uses for `pi-acp`.
 */
async function resolveAcpxPrefix(env: RuntimeEnv): Promise<string[]> {
  try {
    const { exitCode } = await env.exec(['acpx', '--version'])
    if (exitCode === 0) return ['acpx']
  } catch {
    // spawn failed outright (ENOENT) — acpx isn't reachable at all.
  }
  return ['npx', '-y', `acpx@${PINNED_ACPX_VERSION}`]
}

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
   * Force this agent to receive a skill's content deterministically, skipping
   * its own discovery step (forced mode, TODO §P1). Given the skill's name,
   * its SKILL.md body (frontmatter included), and the prompt about to be sent,
   * return the prompt actually sent to the agent. Leave unset to make
   * `loadSkill(dir, { force: true })` throw for this agent — most adapters
   * have no verified forcing lever yet.
   */
  forceSkill?(ctx: { skillName: string; skillBody: string; prompt: string }): string
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
  /**
   * Give every test a fresh `--cwd` and a fresh home dir, instead of sharing
   * this instance's boot-time workspace/home across the whole spec file
   * (TODO §P0). `sessions new` only isolates the *conversation* — hermes also
   * has a cross-session `session search` tool that reads its whole home's
   * session DB regardless of which session is active, so two tests sharing a
   * home leak seeded data between them even though each gets its own
   * `sessions new`. Two things the fix leans on, both real-machine verified
   * (TODO §P0): a home dir is read once, at process start, and never
   * re-read — so just pointing `HERMES_HOME` at a new empty dir does nothing
   * to an already-running process; and acpx's queue-owner keys its long-lived
   * agent process by `--cwd`, so a new `--cwd` is what forces a *new* process
   * to spawn and actually pick up the new home dir.
   *
   * Costs a fresh agent process per test instead of per file — this is why
   * it's opt-in per spec rather than a default on {@link AcpxAgent}: pi and
   * openclaw have no equivalent cross-session surface, so forcing them
   * through the same cost would be paying for a problem they don't have.
   * Unset (the default) leaves today's shared-workspace-per-file behavior
   * untouched.
   *
   * Not compatible with `loadWorkspace()` yet — files copied once at boot
   * would be invisible to any test's actual (per-test) cwd; `loadWorkspace`
   * throws for a spec with this set rather than silently losing the files.
   */
  isolatePerTest?: boolean
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
 * named-session design cannot drive hermes (TODO §V.2 #2). By default, every test
 * shares this instance's workspace as `--cwd`, and a test boundary runs
 * `sessions new` to start a fresh conversation for that cwd — verified green
 * against real hermes 0.18.2 + acpx 0.12.1 (TODO §VI.4). A spec that sets
 * {@link AcpxSpec.isolatePerTest} instead gets a brand-new `--cwd` (and home
 * dir) per test, because `sessions new` alone doesn't isolate an agent surface
 * that reads across sessions (TODO §P0):
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
  /** Skill name → host path, so a re-provisioned test home (isolatePerTest) can re-copy every skill loaded so far. */
  private readonly loadedSkills = new Map<string, string>()
  private acpxPrefixPromise?: Promise<string[]>
  /** Skills loaded with `{ force: true }` (TODO §P1), reinjected into every prompt. */
  private readonly forcedSkills: { name: string; body: string }[] = []
  readonly traces: Trace[] = []

  /** `--cwd` / home dir actually used by the next exec. Equal to the boot-time env's own paths unless {@link AcpxSpec.isolatePerTest} has provisioned a per-test pair (§P0). */
  private activeCwd: string
  private activeHome: string
  private isolatedSeq = 0
  private isolatedProvisioned = false
  private isolatedTestKey: string | undefined

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
    this.activeCwd = opts.env.workspacePath
    this.activeHome = opts.env.agentHome
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

  async loadSkill(hostPath: string, opts?: { force?: boolean }): Promise<SkillHandle> {
    await this.provisionTestScope()
    const name = await readSkillName(hostPath)
    if (!this.loadedSkills.has(name)) {
      await this.env.copyDir(hostPath, join(this.currentSkillsPath(), name))
      this.loadedSkills.set(name, hostPath)
    }
    const forced = !!opts?.force
    if (forced) {
      if (!this.spec.forceSkill) {
        throw new Error(
          `loadSkill(..., { force: true }) is not implemented for ${this.label}: no ` +
            'verified forcing lever yet (TODO §P1). Load it without `force` to rely on ' +
            "the agent's own discovery instead.",
        )
      }
      this.forcedSkills.push({ name, body: await readSkillBody(hostPath) })
    }
    return new SkillHandle(name, hostPath, () => this.traces, this.spec.skillDetector, forced)
  }

  async loadWorkspace(hostPath: string): Promise<string> {
    if (this.workspaceLoaded) {
      throw new Error(
        'loadWorkspace may only be called once per agent instance (§4): merge sources into a single fixture directory instead of layering.',
      )
    }
    if (this.spec.isolatePerTest) {
      throw new Error(
        `loadWorkspace() is not supported for ${this.label}: isolatePerTest (TODO §P0) gives ` +
          "every test its own --cwd, so files copied once here into this instance's shared " +
          "boot-time workspace would be invisible to any test's actual working directory. Not designed yet.",
      )
    }
    await this.env.copyDir(hostPath, this.env.workspacePath)
    this.workspaceLoaded = true
    return this.env.workspacePath
  }

  async run(prompt: string): Promise<Trace> {
    await this.ensureSession()
    const effectivePrompt = this.applyForcedSkills(prompt)
    const argv = await this.buildRunArgv(effectivePrompt)
    const { stdout, stderr, exitCode } = await withHeartbeat(
      `acpx ${this.label} run: "${preview(prompt)}"`,
      () => this.env.exec(argv, { env: this.execEnv() }),
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
    // Archive *before* the silent-turn check below, so the stream that explains
    // the failure is on disk by the time the throw reaches the reporter.
    this.traces.push(trace)
    this.onTrace?.({ trace, sessionJsonl: session })
    if (isSilentTurn(trace)) {
      throw new Error(await this.failure('produced no output', silentTurnHint(stderr)))
    }
    return trace
  }

  /** Drop the current session so the next run() starts a fresh cwd conversation. */
  reset(): void {
    this.hasSession = false
  }

  /**
   * Rewrite the prompt through {@link AcpxSpec.forceSkill} for every
   * force-loaded skill (TODO §P1), in load order. A no-op when nothing was
   * loaded with `{ force: true }` — `loadSkill` already rejected the load if
   * the spec has no `forceSkill` hook, so this never has skills queued for an
   * agent that can't honor them.
   */
  private applyForcedSkills(prompt: string): string {
    let out = prompt
    for (const skill of this.forcedSkills) {
      out = this.spec.forceSkill!({ skillName: skill.name, skillBody: skill.body, prompt: out })
    }
    return out
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
    await this.provisionTestScope()
    const test = this.currentTest?.()
    if (this.hasSession && test === this.sessionTest) return
    const argv = [...(await this.acpxFrame()), 'sessions', 'new']
    const { stdout, stderr, exitCode } = await this.env.exec(argv, { env: this.execEnv() })
    if (exitCode !== 0) {
      throw new Error(await this.failure(`sessions new failed (${exitCode})`, stderr || stdout))
    }
    this.sessionTest = test
    this.hasSession = true
  }

  /**
   * For an {@link AcpxSpec.isolatePerTest} agent (hermes, TODO §P0): give the
   * current test its own `--cwd` and home dir before anything touches either,
   * so a fresh queue-owner + agent process spins up for it and reads a fresh,
   * empty home instead of inheriting whatever the previous test left behind —
   * critically including hermes' session DB, which its `session search` tool
   * reads across the whole home regardless of which `sessions new` is active.
   * A no-op for every other spec (`activeCwd`/`activeHome` stay pinned to the
   * boot-time env for the instance's whole life, exactly like before this
   * flag existed). Idempotent per test: both `loadSkill()` and
   * `ensureSession()` call this, so whichever runs first for a given test
   * does the provisioning and the other sees it already done.
   */
  private async provisionTestScope(): Promise<void> {
    if (!this.spec.isolatePerTest) return
    const test = this.currentTest?.()
    if (this.isolatedProvisioned && test === this.isolatedTestKey) return
    this.isolatedSeq++
    const root = join(this.env.workspacePath, '.agentfoo-tests', `t${this.isolatedSeq}`)
    this.activeCwd = join(root, 'ws')
    this.activeHome = join(root, 'home')
    await this.env.exec(['sh', '-c', `mkdir -p "${this.activeCwd}" "${join(this.activeHome, 'skills')}"`])
    if (this.spec.init) {
      await this.spec.init({ env: this.scopedEnv(), config: this.config, credentialEnv: this.credentialEnv })
    }
    // Re-seed every skill loaded in an earlier test into this test's fresh
    // home — the previous home's copy is invisible to the new process.
    for (const [name, hostPath] of this.loadedSkills) {
      await this.env.copyDir(hostPath, join(this.activeHome, 'skills', name))
    }
    this.isolatedProvisioned = true
    this.isolatedTestKey = test
    this.hasSession = false // the new cwd has no acpx session yet
  }

  /** Where `loadSkill()` should copy into right now — the isolated per-test home's skills dir if {@link AcpxSpec.isolatePerTest}, else the shared boot-time one. */
  private currentSkillsPath(): string {
    return this.spec.isolatePerTest ? join(this.activeHome, 'skills') : this.env.skillsPath
  }

  /**
   * A {@link RuntimeEnv} view pointed at the current per-test `activeHome`
   * instead of the boot-time one, so {@link AcpxSpec.init} — written once
   * against `env.agentHome` (hermes/pi/openclaw's `init` hooks all reference
   * it directly) — can be replayed unchanged against an isolated home. Exec
   * and file ops still delegate to the real env; only the path fields differ.
   */
  private scopedEnv(): RuntimeEnv {
    const env = this.env
    return {
      id: env.id,
      workspacePath: this.activeCwd,
      skillsPath: this.currentSkillsPath(),
      agentHome: this.activeHome,
      homeEnvVar: env.homeEnvVar,
      exec: (argv, opts) => env.exec(argv, opts),
      copyDir: (hostSrc, dest) => env.copyDir(hostSrc, dest),
      readFile: (path) => env.readFile(path),
      teardown: () => env.teardown(),
    }
  }

  /** Env vars for an exec that must reach the currently active agent process: credentials, plus (isolatePerTest only) this test's own home dir — overriding the boot-time default the runtime would otherwise inject. */
  private execEnv(): Record<string, string> {
    if (!this.spec.isolatePerTest) return this.credentialEnv
    return { ...this.credentialEnv, [this.env.homeEnvVar]: this.activeHome }
  }

  /** Resolve and memoize how to invoke acpx on this env (TODO §P1.5 #3). */
  private acpxPrefix(): Promise<string[]> {
    if (!this.acpxPrefixPromise) this.acpxPrefixPromise = resolveAcpxPrefix(this.env)
    return this.acpxPrefixPromise
  }

  /**
   * The `acpx … --cwd <ws>` prefix shared by every invocation, with the agent
   * target and all top-level options placed *before* any subcommand (commander
   * resolves globals before the command). For `launchCommand`, `--agent '<cmd>'`
   * is itself the target; for a built-in `agent`, its name is the subcommand.
   */
  private async acpxFrame(extraGlobals: string[] = []): Promise<string[]> {
    const prefix = await this.acpxPrefix()
    const ttlGlobals = this.spec.isolatePerTest
      ? ['--ttl', String(ISOLATED_QUEUE_OWNER_TTL_SECONDS)]
      : []
    const globals = this.spec.launchCommand
      ? ['--agent', this.spec.launchCommand, '--cwd', this.activeCwd, ...ttlGlobals, ...extraGlobals]
      : ['--cwd', this.activeCwd, ...ttlGlobals, ...extraGlobals]
    const agentToken = this.spec.launchCommand ? [] : [this.spec.agent as string]
    return [...prefix, ...globals, ...agentToken]
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

  private async buildRunArgv(prompt: string): Promise<string[]> {
    const globals = ['--approve-all', '--format', 'json']
    const model = this.spec.modelFlag?.(this.config)
    if (model) globals.push('--model', model)
    const argv = [...(await this.acpxFrame(globals)), prompt]
    if (this.config.extraArgs) argv.push(...this.config.extraArgs)
    return argv
  }
}

/** Byte count as MiB, for the one progress line that reports a size. */
function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/**
 * Did the agent answer at all? A turn where the model emitted no text, no
 * reasoning and no tool call is never a legitimate result — it means the agent
 * never reached its provider, and the run is not testable.
 *
 * Worth an explicit check because nothing upstream reports it as an error: a pi
 * `models.json` with an unresolvable `apiKey` 401s, pi-acp turns that into
 * `stopReason: end_turn` with zero content, and acpx still exits 0. Without this
 * the empty trace flows into the spec and fails whichever assertion happens to
 * come first — the observed symptom was `expect(skill).toHaveBeenCalled()`
 * failing, which points at skill wiring and not at the dead credential.
 *
 * Reasoning counts as output on purpose: hermes activates a preloaded skill with
 * no tool call and names it only in `reasoning`, so a thought-only turn is a real
 * turn for at least one supported agent.
 */
function isSilentTurn(trace: Trace): boolean {
  if (trace.toolCalls.length) return false
  return !trace.messages.some(
    (m) => m.role !== 'user' && (m.content.trim() || m.reasoning?.trim()),
  )
}

/** Body of the {@link isSilentTurn} error: what it means, plus acpx's own stderr. */
function silentTurnHint(stderr: string): string {
  return (
    'The turn ended with no assistant message, no reasoning and no tool call, yet acpx ' +
    'exited 0.\nThis is almost always the agent\'s own provider wiring failing silently — ' +
    'check the\nmodel id, base URL, and that the API key reference in the config this ' +
    "adapter writes\nresolves against the container's env (`passEnv`)." +
    (stderr.trim() ? `\n\nacpx stderr:\n${stderr.trim()}` : '')
  )
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
