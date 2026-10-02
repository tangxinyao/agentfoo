import { join } from 'node:path'
import type { AgentConfig } from '../types.js'
import type { AcpxSpec } from './acpx.js'
import { reasoningReferenceDetector } from '../skill.js'
import { inlineSkillPrompt } from './shared.js'

/**
 * hermes-agent (NousResearch) driven through the acpx ACP client, NOT its own
 * `hermes chat` CLI. acpx spawns `hermes acp` (hermes' editor/ACP mode) via the
 * `--agent` escape hatch, and agentfoo isolates per test by working directory —
 * the {@link AcpxAgent} cwd-session model. This was verified green against a real
 * hermes 0.18.2 + acpx 0.12.1 container (TODO §VI.4); the earlier native
 * `hermes chat`/`sessions export` adapter and the acpx *named*-session design it
 * replaced are both gone (see git history + TODO §V/§VI).
 *
 * hermes still reads model/provider/base_url/memory from the `config.yaml`
 * {@link hermesAcpxSpec.init} writes into HERMES_HOME, and its API key stays
 * off-disk, forwarded via `passEnv` (TODO §V.5). {@link resolveModelProvider} and
 * {@link renderConfigYaml} are shared helpers reused by the generic
 * {@link file://./command.ts} adapter too.
 */

/**
 * Split a possibly `provider/model` string (e.g. `deepseek/deepseek-v4-pro`)
 * into a bare model id and a provider, mirroring the judge's convention (§6, F4)
 * so the agent and judge configs read the same way. An explicit `config.provider`
 * always wins over the prefix; the prefix is stripped from the model either way.
 */
export function resolveModelProvider(config: AgentConfig): { model?: string; provider?: string } {
  const { model, provider } = config
  if (!model || !model.includes('/')) return { model, provider }
  const slash = model.indexOf('/')
  return { model: model.slice(slash + 1), provider: provider ?? model.slice(0, slash) }
}

/**
 * Render a minimal hermes `config.yaml` (§7). hermes expects `model` to be a
 * *mapping* (`default` / `provider` / `base_url`), not a bare string — verified
 * against a real hermes 0.18 home. `base_url` has no acpx CLI flag, so a provider
 * without a built-in endpoint must set it here. (DeepSeek is first-class in
 * 0.18.2, so its endpoint may be built-in — writing an explicit `base_url` when
 * given stays correct either way.)
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

/**
 * The hermes {@link AcpxSpec}: reached through `acpx --agent 'hermes acp'`, with
 * model/provider/base_url/memory configured via the `config.yaml` written into
 * HERMES_HOME (so no `modelFlag` is set). Registered as the `hermes` kind in
 * {@link file://./registry.ts}.
 */
export const hermesAcpxSpec: AcpxSpec = {
  launchCommand: 'hermes acp',
  label: 'hermes',
  // hermes preloads skills into its system prompt, so a skill firing is not a
  // tool call at all — the signal is the model naming it in reasoning (§5,
  // verified against real traces). This was previously pinned per-suite via
  // `setSkillDetector`, which is a per-worker global and would have mis-graded
  // any second agent booted alongside hermes.
  skillDetector: reasoningReferenceDetector,
  // hermes' `session search` tool reads across its whole home's session DB
  // regardless of which `sessions new` conversation is active, so two tests
  // sharing a home leak seeded data between them (TODO §P0, real-machine
  // reproduced: a secret seeded in one test came back verbatim when a later
  // test asked it to search its own history). pi/openclaw have no equivalent
  // surface, so this stays unset for them.
  isolatePerTest: true,
  /**
   * Forced mode (TODO §P1): inline the SKILL.md body directly ahead of the
   * prompt. Chosen over the other two candidates the TODO named, both ruled
   * out without needing a live call: (a) a literal `/<skill-name> <prompt>`
   * slash command — a real captured hermes trace's `available_commands_update`
   * lists only generic gateway commands (`help`, `model`, `bash`, `compact`, …),
   * no per-skill entries, so hermes' ACP bridge has nothing to parse a
   * `/<skill-name>` into; it would just be literal text. (b) acpx's
   * `--append-system-prompt` — its own `--help` documents this as routing
   * through ACP `_meta.systemPrompt.append`, which is a claude-agent-acp
   * extension; hermes' ACP bridge has no code reading that `_meta` key, so it
   * would be a silent no-op. Inlining is the one lever guaranteed to reach the
   * model regardless of bridge internals, at the cost of prompt-level (not
   * true system-prompt-level) placement.
   */
  forceSkill: inlineSkillPrompt,
  async init({ env, config }): Promise<void> {
    await env.writeFile(join(env.agentHome, 'config.yaml'), `${renderConfigYaml(config)}\n`)
  },
}
