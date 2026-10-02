import { join } from 'node:path'
import type { AgentConfig, Trace } from '../types.js'
import type { RuntimeEnv } from '../runtime/types.js'
import type { Agent, AgentBootOptions } from './types.js'
import { parseOpencodeTrace } from '../trace.js'
import { SkillHandle } from '../skill.js'
import { preview, progress, withHeartbeat } from '../progress.js'
import { collectCredentials, readSkillName } from './shared.js'
import { resolveModelProvider } from './hermes.js'

/**
 * Adapter for sst's opencode (§7). opencode has a clean non-interactive CLI:
 * `opencode run "<prompt>" --model <provider/model> --format json` prints the
 * turn's events as JSON on stdout, so — unlike hermes — there is no separate
 * `sessions export` step; the run output *is* the trace source.
 *
 * VERIFY-CLI (confirm against a real opencode binary): the `run --format json`
 * envelope (parsed by {@link parseOpencodeTrace}), the custom-provider config
 * schema written by {@link renderOpencodeConfig}, and how a skill directory is
 * preloaded (opencode's skill/command mechanism differs from hermes `-s`).
 */
export class OpencodeAgent implements Agent {
  private readonly env: RuntimeEnv
  private readonly config: AgentConfig
  private readonly onTrace?: AgentBootOptions['onTrace']
  private readonly currentTest?: () => string | undefined
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
    this.credentialEnv = collectCredentials(opts.config.passEnv)
  }

  get workspacePath(): string {
    return this.env.workspacePath
  }

  /** Write the opencode config (custom provider / base_url) into the agent home. */
  async init(): Promise<void> {
    const json = renderOpencodeConfig(this.config)
    if (!json) return
    const dir = join(this.env.agentHome, 'opencode')
    await this.env.exec(['sh', '-c', `mkdir -p "${dir}"`])
    await this.env.exec(['sh', '-c', `cat > "${join(dir, 'opencode.json')}" <<'AGENTFOO_EOF'\n${json}\nAGENTFOO_EOF`])
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
    const argv = this.buildRunArgv(prompt)
    const { stdout, stderr, exitCode } = await withHeartbeat(
      `opencode run: "${preview(prompt)}"`,
      () => this.env.exec(argv, { env: this.credentialEnv }),
    )
    if (exitCode !== 0) {
      throw new Error(`opencode run exited ${exitCode}\n${stderr || stdout}`)
    }

    this.sessionId = extractOpencodeSessionId(stdout) ?? this.sessionId
    this.started = true

    const trace = parseOpencodeTrace(stdout)
    progress(`  trace: ${trace.messages.length} messages, ${trace.toolCalls.length} tool calls`)
    this.traces.push(trace)
    this.onTrace?.({ trace, sessionJsonl: stdout })
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
    const argv = ['opencode', 'run', prompt, '--format', 'json']
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
