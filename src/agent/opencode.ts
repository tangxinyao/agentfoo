import { join } from 'node:path'
import type { AgentConfig, Trace } from '../types.js'
import type { RuntimeEnv } from '../runtime/types.js'
import type { Agent, AgentBootOptions, RunOptions } from './types.js'
import { parseOpencodePartTrace } from '../trace.js'
import { SkillHandle } from '../skill.js'
import { preview } from '../progress.js'
import { collectCredentials, readSkillName } from './shared.js'
import { execTurn, finishTurn } from './turn.js'
import { resolveModelProvider } from './hermes.js'

/**
 * Adapter for opencode (§7). opencode has a clean non-interactive CLI:
 * `opencode run "<prompt>" --model <provider/model> --format json` prints the
 * turn's events as JSON on stdout, so — unlike hermes — there is no separate
 * `sessions export` step; the run output *is* the trace source.
 *
 * The *flags* are verified against the real 1.18.5 binary (TODO §3): `run` takes
 * `--format default|json`, `-m/--model <provider/model>`, `-s/--session <id>`,
 * `-c/--continue`, and `--auto` (the non-interactive approval flag, opencode's
 * analogue of hermes' `--approve-all`).
 *
 * VERIFY-CLI (still needs a live turn): the `run --format json` envelope itself
 * (parsed by {@link parseOpencodePartTrace}), the real session-id key
 * ({@link extractOpencodeSessionId} guesses three shapes), the custom-provider
 * schema written by {@link renderOpencodeConfig}, and which directory opencode
 * reads skills from. `scripts/probe-opencode.sh` answers all four in one
 * container session.
 */
export class OpencodeAgent implements Agent {
  private readonly env: RuntimeEnv
  private readonly config: AgentConfig
  private readonly onTrace?: AgentBootOptions['onTrace']
  private readonly currentTest?: () => string | undefined
  /** Adapter-enforced per-turn bound (see {@link AgentBootOptions.turnTimeoutMs}). */
  private readonly turnTimeoutMs?: number
  private readonly credentialEnv: Record<string, string>

  private sessionId: string | undefined
  private started = false
  private workspaceLoaded = false
  private readonly loadedSkills = new Set<string>()
  private sessionTest: string | undefined
  readonly traces: Trace[] = []

  constructor(opts: AgentBootOptions) {
    this.env = opts.env
    this.config = opts.config
    this.onTrace = opts.onTrace
    this.currentTest = opts.currentTest
    this.turnTimeoutMs = opts.turnTimeoutMs
    this.credentialEnv = collectCredentials(opts.config.passEnv)
  }

  get workspacePath(): string {
    return this.env.workspacePath
  }

  /** Write the opencode config (custom provider / base_url) into the agent home. */
  async init(): Promise<void> {
    const json = renderOpencodeConfig(this.config)
    if (!json) return
    await this.env.writeFile(join(this.env.agentHome, 'opencode', 'opencode.json'), `${json}\n`)
  }

  async loadSkill(hostPath: string, opts?: { force?: boolean }): Promise<SkillHandle> {
    if (opts?.force) {
      throw new Error(
        'loadSkill(..., { force: true }) is not implemented for opencode: no verified ' +
          'forcing lever yet (TODO §P1). Load it without `force` to rely on the native ' +
          '`skill` tool + autonomous discovery instead.',
      )
    }
    const name = await readSkillName(hostPath)
    if (!this.loadedSkills.has(name)) {
      // opencode discovers global skills at `$XDG_CONFIG_HOME/opencode/skills/
      // <name>/SKILL.md` — NOT the runtime's shared `skillsPath`
      // (`$XDG_CONFIG_HOME/skills`), which is where hermes reads them from. The
      // missing `opencode/` segment meant the skill was copied into the
      // container but never discovered, so the agent answered the design prompt
      // unaided and `toHaveBeenCalled` failed with no tool calls at all.
      // (Project-level `<cwd>/.opencode/skills` also works; the global dir is
      // used to keep the workspace exactly as the fixture seeded it.)
      await this.env.copyDir(hostPath, join(this.env.agentHome, 'opencode', 'skills', name))
      this.loadedSkills.add(name)
    }
    // No adapter-level detector: opencode exposes a native `skill` tool, so a
    // firing is a genuine `skill({ name })` tool call — the one agent the
    // built-in `detectSkillInvocations` heuristic was written for (§8.1). Still
    // unconfirmed against a live trace; pin it here if the probe says otherwise.
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

  async run(prompt: string, opts: RunOptions = {}): Promise<Trace> {
    const test = this.currentTest?.()
    if (test !== this.sessionTest) {
      this.reset()
      this.sessionTest = test
    }
    // Snapshotted for artifact filing: after a test timeout vitest has already
    // moved the global current-test name on to the next test (TODO §timeout,
    // see AcpxAgent.run for the failure this caused).
    const turnTest = test
    const timeoutMs = opts.timeout ?? this.turnTimeoutMs
    const argv = this.buildRunArgv(prompt)
    // opencode reports each tool already-completed, so model and tool time share
    // windows here: label the split coarse instead of claiming precision.
    const outcome = await execTurn({
      label: `opencode run: "${preview(prompt)}"`,
      argv,
      env: this.env,
      execEnv: this.credentialEnv,
      timeoutMs,
      splitQuality: 'coarse',
    })
    const trace = await finishTurn(outcome, {
      label: 'opencode',
      prompt,
      timeoutMs,
      parse: parseOpencodePartTrace,
      archive: (artifacts) =>
        this.onTrace?.({ ...artifacts, ...(turnTest !== undefined ? { testName: turnTest } : {}) }),
      remember: (t) => this.traces.push(t),
      exitMessage: (r) => `opencode run exited ${r.exitCode}\n${r.stderr || r.stdout}`,
      // A killed turn's session must not be continued.
      onBadTurn: () => this.reset(),
    })

    this.sessionId = extractOpencodeSessionId(outcome.result.stdout) ?? this.sessionId
    this.started = true
    return trace
  }

  reset(): void {
    this.sessionId = undefined
    this.started = false
  }

  async teardown(): Promise<void> {
    await this.env.teardown()
  }

  private buildRunArgv(prompt: string): string[] {
    // `--auto` auto-approves permissions that are not explicitly denied — the
    // non-interactive lever hermes spells `--approve-all`. Verified present on
    // `opencode run` 1.18.5; without it a turn that edits a file can block on a
    // permission prompt with no tty to answer it.
    const argv = ['opencode', 'run', prompt, '--format', 'json', '--auto']
    const model = modelFlag(this.config)
    if (model) argv.push('--model', model)
    // Continue the same session across turns within a test. Prefer an explicit
    // id when we captured one; otherwise `-c` continues the last session (safe
    // because runs are serialized, §6).
    if (this.sessionId) argv.push('--session', this.sessionId)
    else if (this.started) argv.push('-c')
    if (this.config.extraArgs) argv.push(...this.config.extraArgs)
    return argv
  }
}

/** `provider/model` for opencode's `--model` flag, or just the model. */
export function modelFlag(config: AgentConfig): string | undefined {
  const { model, provider } = resolveModelProvider(config)
  if (!model) return undefined
  return provider ? `${provider}/${model}` : model
}

/**
 * Extract an opencode session id from `run --format json` output so subsequent
 * turns can `--session <id>`. Tolerant of `"sessionID":"…"` / `session_id` /
 * `"session":{"id":"…"}` shapes. VERIFY-CLI against a real trace.
 */
export function extractOpencodeSessionId(text: string): string | undefined {
  const m =
    text.match(/"session[_]?id"\s*:\s*"([^"]+)"/i) ??
    text.match(/"sessionID"\s*:\s*"([^"]+)"/i) ??
    text.match(/"session"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/i)
  return m?.[1]
}

/**
 * Render an opencode config JSON that registers a custom OpenAI-compatible
 * provider for base_url'd endpoints (deepseek/glm/minimax/kimi). Returns
 * undefined when there is nothing to configure (built-in provider, no base_url).
 *
 * VERIFY-CLI: opencode's custom-provider schema (npm loader id, options.baseURL,
 * models map, `{env:VAR}` interpolation) must be confirmed against opencode docs.
 */
export function renderOpencodeConfig(config: AgentConfig): string | undefined {
  const { model, provider } = resolveModelProvider(config)
  if (!config.baseUrl || !provider) return undefined

  const apiKeyEnv = config.passEnv?.[0]
  const doc: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [provider]: {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: config.baseUrl,
          ...(apiKeyEnv ? { apiKey: `{env:${apiKeyEnv}}` } : {}),
        },
        ...(model ? { models: { [model]: {} } } : {}),
      },
    },
  }
  return JSON.stringify(doc, null, 2)
}
