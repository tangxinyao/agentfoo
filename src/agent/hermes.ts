import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AgentConfig, Trace } from '../types.js'
import type { RuntimeEnv } from '../runtime/types.js'
import { parseTrace } from '../trace.js'
import { SkillHandle } from '../skill.js'
import { preview, progress, withHeartbeat } from '../progress.js'

export interface HermesBootOptions {
  env: RuntimeEnv
  config: AgentConfig
  /** Unique tag so `sessions export` can find this instance's sessions. */
  sourceTag: string
  /**
   * Called after every `run()` with the turn's trace and the raw session
   * jsonl. Used by the fixture layer to drop per-test artifacts (§9) without
   * coupling this adapter to vitest or the filesystem layout.
   */
  onTrace?: (info: { trace: Trace; sessionJsonl: string }) => void
  /**
   * Identifies the currently executing test. When it changes between `run()`s,
   * the session is reset so each test starts a fresh conversation (multi-turn
   * *within* a test continues, since the name is stable across its own runs).
   * Injected by the fixture layer so this adapter stays vitest-agnostic (§7).
   */
  currentTest?: () => string | undefined
}

/**
 * Adapter for NousResearch's hermes-agent (§7). Owns the mapping between
 * agentfoo's fixture API (`run` / `loadSkill` / `loadWorkspace` / `reset`) and
 * the real hermes CLI, and normalizes each turn's session export into a Trace.
 */
export class HermesAgent {
  private readonly env: RuntimeEnv
  private readonly config: AgentConfig
  private readonly sourceTag: string
  private readonly onTrace?: (info: { trace: Trace; sessionJsonl: string }) => void

  private sessionId: string | undefined
  private workspaceLoaded = false
  /** Names of skills preloaded via `-s`, deduped so a per-test load adds once. */
  private readonly loadedSkills = new Set<string>()
  /** Provider credentials forwarded into the env on every hermes invocation. */
  private readonly credentialEnv: Record<string, string>
  private readonly currentTest?: () => string | undefined
  /** Name of the test that owns the current session, for boundary detection. */
  private sessionTest: string | undefined
  readonly traces: Trace[] = []

  constructor(opts: HermesBootOptions) {
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

  /** Write hermes config.yaml into the isolated agent home (§7). */
  async init(): Promise<void> {
    const yaml = renderConfigYaml(this.config)
    await this.env.exec(['sh', '-c', `mkdir -p "${this.env.agentHome}"`])
    await this.env.exec(['sh', '-c', `cat > "${join(this.env.agentHome, 'config.yaml')}" <<'AGENTFOO_EOF'\n${yaml}\nAGENTFOO_EOF`])
  }

  /** Copy a skill directory into the agent home so `-s <name>` can preload it. */
  async loadSkill(hostPath: string): Promise<SkillHandle> {
    const name = await readSkillName(hostPath)
    // Copy + register for `-s` preload once per agent; a repeat call (e.g. from a
    // per-test fixture reusing a file-scoped agent) just mints a fresh spy handle
    // whose call window starts now, so each test sees only its own invocations.
    if (!this.loadedSkills.has(name)) {
      await this.env.copyDir(hostPath, join(this.env.skillsPath, name))
      this.loadedSkills.add(name)
    }
    return new SkillHandle(name, hostPath, () => this.traces)
  }

  /** Seed initial workspace files. Only callable once per instance (§4). */
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

  /** One conversation turn. Subsequent calls continue the same session (§4). */
  async run(prompt: string): Promise<Trace> {
    // Test boundary → fresh session, so cases sharing a file-scoped agent (§4)
    // don't leak conversation state into each other. A no-op within one test.
    const test = this.currentTest?.()
    if (test !== this.sessionTest) {
      this.reset()
      this.sessionTest = test
    }
    const argv = this.buildChatArgv(prompt)
    const { stdout, stderr, exitCode } = await withHeartbeat(
      `hermes run: "${preview(prompt)}"`,
      () => this.env.exec(argv, { env: this.credentialEnv }),
    )
    if (exitCode !== 0) {
      throw new Error(`hermes chat exited ${exitCode}\n${stderr || stdout}`)
    }

    const sessionId = extractSessionId(stdout) ?? (await this.resolveLatestSession())
    if (!sessionId) {
      throw new Error(`could not determine hermes session id from run output:\n${stdout}`)
    }
    this.sessionId = sessionId

    const jsonl = await this.exportSession(sessionId)
    const trace = parseTrace(jsonl)
    progress(`  trace: ${trace.messages.length} messages, ${trace.toolCalls.length} tool calls`)
    this.traces.push(trace)
    this.onTrace?.({ trace, sessionJsonl: jsonl })
    return trace
  }

  /** Start a fresh session on the next run() without tearing down the env (§4). */
  reset(): void {
    this.sessionId = undefined
  }

  async teardown(): Promise<void> {
    await this.env.teardown()
  }

  private buildChatArgv(prompt: string): string[] {
    const argv = ['hermes', '--yolo', 'chat', '-q', prompt, '-Q', '--source', this.sourceTag]
    const { model, provider } = resolveModelProvider(this.config)
    if (model) argv.push('-m', model)
    if (provider) argv.push('--provider', provider)
    for (const name of this.loadedSkills) argv.push('-s', name)
    if (this.sessionId) argv.push('-r', this.sessionId)
    if (this.config.extraArgs) argv.push(...this.config.extraArgs)
    return argv
  }

  private async exportSession(sessionId: string): Promise<string> {
    const { stdout, stderr, exitCode } = await this.env.exec(
      ['hermes', 'sessions', 'export', '--session-id', sessionId, '--format', 'jsonl', '-'],
      { env: this.credentialEnv },
    )
    if (exitCode !== 0) throw new Error(`hermes sessions export failed:\n${stderr || stdout}`)
    return stdout
  }

  /** Fallback session lookup when stdout parsing fails (§11 verify item). */
  private async resolveLatestSession(): Promise<string | undefined> {
    const { stdout } = await this.env.exec(
      ['hermes', 'sessions', 'list', '--source', this.sourceTag, '--limit', '1'],
      { env: this.credentialEnv },
    )
    return extractSessionId(stdout)
  }
}

/**
 * Extract a hermes session id from CLI output. Verified against hermes 0.18:
 * `-Q` prints a `session_id: <id>` line on exit, and `sessions list` prints the
 * id as the last column of a table row. hermes ids look like
 * `20260711_204347_8f4901` (`YYYYMMDD_HHMMSS_<hex>`), so the native-format
 * pattern is tried first; the labelled / uuid patterns are kept as fallbacks
 * for other id shapes.
 */
export function extractSessionId(text: string): string | undefined {
  const patterns = [
    /\b(\d{8}_\d{6}_[0-9a-f]{4,})\b/i,
    /session[ _]?id["'\s:=]+([A-Za-z0-9][\w-]{5,})/i,
    /(?:--resume|--continue|resume|continue)\s+([A-Za-z0-9][\w-]{5,})/i,
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) return m[1]
  }
  return undefined
}

/**
 * Split a possibly `provider/model` string (e.g. `deepseek/deepseek-v4-pro`)
 * into a bare model id and a provider, mirroring the judge's convention (§6, F4)
 * so the agent and judge configs read the same way. An explicit `config.provider`
 * always wins over the prefix; the prefix is stripped from the model either way
 * so hermes receives a bare `-m` value.
 */
export function resolveModelProvider(config: AgentConfig): { model?: string; provider?: string } {
  const { model, provider } = config
  if (!model || !model.includes('/')) return { model, provider }
  const slash = model.indexOf('/')
  return { model: model.slice(slash + 1), provider: provider ?? model.slice(0, slash) }
}

/**
 * Read the named host env vars into a plain object, skipping any that are
 * unset. These are forwarded into the runtime on every hermes invocation so an
 * in-container hermes can authenticate with the inference provider (§7) without
 * baking secrets into the image or config.
 */
function collectCredentials(names: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names ?? []) {
    const value = process.env[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

async function readSkillName(hostPath: string): Promise<string> {
  try {
    const md = await readFile(join(hostPath, 'SKILL.md'), 'utf8')
    const m = md.match(/^name:\s*(.+)$/m)
    if (m) return m[1].trim()
  } catch {
    /* fall through to dir name */
  }
  return basename(hostPath)
}

/**
 * Render a minimal hermes `config.yaml` (§7). hermes expects `model` to be a
 * *mapping* (`default` / `provider` / `base_url`), not a bare string — verified
 * against a real hermes 0.18 home. The CLI `-m` / `--provider` flags override
 * `default` / `provider`, but `base_url` has no CLI flag, so providers without a
 * built-in endpoint (e.g. deepseek) must set it here.
 */
export function renderConfigYaml(config: AgentConfig): string {
  const lines: string[] = []
  const { model, provider } = resolveModelProvider(config)
  if (model || provider || config.baseUrl) {
    lines.push('model:')
    if (model) lines.push(`  default: ${model}`)
    if (provider) lines.push(`  provider: ${provider}`)
    if (config.baseUrl) lines.push(`  base_url: ${config.baseUrl}`)
  }
  // Disable self-learning by default so repeated runs stay reproducible (§7).
  lines.push('memory:')
  lines.push(`  memory_enabled: ${config.memory === true}`)
  return lines.join('\n')
}
