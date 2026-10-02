import { join } from 'node:path'
import type { AgentConfig } from '../types.js'
import type { AcpxSpec } from './acpx.js'
import { skillFileReadDetector } from '../skill.js'
import { resolveModelProvider } from './hermes.js'
import { inlineSkillPrompt } from './shared.js'

/**
 * pi (https://github.com/mariozechner/pi, npm `@mariozechner/pi-coding-agent`)
 * driven through the acpx ACP client as the built-in `pi` agent, i.e.
 * `acpx --cwd <ws> pi …` — the same cwd-session model as hermes, so it reuses
 * {@link file://./acpx.ts AcpxAgent} wholesale and differs only in this spec.
 *
 * Verified against a real pi 0.73.1 + pi-acp 0.0.32 + acpx 0.12.1 container:
 * `sessions new` then a prompt turn returns exit 0, executes tools for real, and
 * streams the ACP envelope {@link parseAcpTrace} already decodes.
 *
 * Three things about pi are load-bearing and were previously unknown:
 *
 * 1. **`acpx pi` is not self-contained.** acpx does not speak pi's protocol
 *    directly; it spawns the separate `pi-acp` adapter package, fetching it with
 *    `npx pi-acp@^0.0.31` on first use if absent. The Dockerfile pre-installs it
 *    pinned so a test run neither reaches npm nor drifts.
 * 2. **Config lives in `$PI_CODING_AGENT_DIR`** (default `~/.pi/agent`), which is
 *    why that — not `ACPX_HOME` — is the kind's `homeEnvVar`. Pointing it at the
 *    runtime's isolated home puts both files pi needs exactly where the runtime
 *    already puts them: `models.json` at its root ({@link renderPiModelsJson})
 *    and skills under `skills/<name>/SKILL.md`, which is `RuntimeEnv.skillsPath`
 *    unchanged. acpx keeps using the image's `ACPX_HOME` for its own sessions.
 * 3. **The model flag must stay provider-qualified.** `models.json` may define a
 *    model id that a built-in provider also offers, so `--model deepseek/x`
 *    resolves unambiguously where a bare `x` relies on pi's fuzzy matching.
 */

/**
 * Render pi's `models.json` — the file that registers a custom OpenAI-compatible
 * provider, and the reason this adapter needs an `init` at all: acpx has only a
 * generic `--model`, with nowhere to put a `base_url`, so an endpoint like
 * DeepSeek's is unreachable until this file exists.
 *
 * Schema confirmed against the pinned release's own `docs/models.json` reference:
 * `providers.<name>.{baseUrl,api,apiKey,models[]}`, where `api` is one of
 * `openai-completions` / `openai-responses` / `anthropic-messages` /
 * `google-generative-ai`. Returns undefined when there is nothing to configure —
 * a provider pi has built in authenticates from the env var alone.
 *
 * `apiKey` is deliberately a `${VAR}` *reference*, not a key, so the secret keeps
 * arriving through `passEnv` and never lands on the container's disk. **The `$`
 * is load-bearing, and which spelling works changed under us**:
 *
 * - pi 0.82.1 interpolates `$ENV_VAR` / `${ENV_VAR}` in config values (`!` runs a
 *   command, `$$` escapes a `$`). A **bare** `DEEPSEEK_API_KEY` is not a variable
 *   name there — it is sent as the literal key.
 * - pi 0.73.1, the version `dockers/pi.Dockerfile` pins, documents bare as "env
 *   var name or literal value" and accepts **both** spellings.
 *
 * `${VAR}` is therefore the only spelling that works on both, which is why it is
 * the one written here — probed against real 0.73.1 and 0.82.1 binaries.
 *
 * Two things made the bare version survive this long. It never failed in Docker:
 * a control run on 0.73.1 with a deliberately nonexistent var name **still
 * authenticated**, because `deepseek` collides with a provider pi has built in,
 * and that one reads `DEEPSEEK_API_KEY` from the env directly — so this line was
 * never load-bearing there and the suite's green said nothing about it. And when
 * 0.82.1 did make it load-bearing, the failure was invisible: pi-acp swallows the
 * 401 and answers `stopReason: end_turn` with zero content, so acpx still exits 0
 * and the only symptom is an empty trace ({@link isSilentTurn} now catches that).
 */
export function renderPiModelsJson(config: AgentConfig): string | undefined {
  const { model, provider } = resolveModelProvider(config)
  if (!config.baseUrl || !provider) return undefined

  const apiKeyEnv = config.passEnv?.[0]
  const doc = {
    providers: {
      [provider]: {
        baseUrl: config.baseUrl,
        api: 'openai-completions',
        ...(apiKeyEnv ? { apiKey: `\${${apiKeyEnv}}` } : {}),
        models: model ? [{ id: model }] : [],
      },
    },
  }
  return JSON.stringify(doc, null, 2)
}

/** `provider/model` for pi's `--model`, or the bare model when no provider is known. */
export function piModelFlag(config: AgentConfig): string | undefined {
  const { model, provider } = resolveModelProvider(config)
  if (!model) return undefined
  return provider ? `${provider}/${model}` : model
}

/**
 * The pi {@link AcpxSpec}: the built-in `pi` acpx agent, its provider configured
 * through the `models.json` written into `PI_CODING_AGENT_DIR`. Registered as the
 * `pi` kind in {@link file://./registry.ts}.
 */
export const piAcpxSpec: AcpxSpec = {
  agent: 'pi',
  label: 'pi',
  modelFlag: piModelFlag,
  // pi has no skill tool — it lists skills in the system prompt with their paths
  // and the model `read`s the one it wants, so the firing signal is that file
  // read, not a tool named after the skill (§5, verified against a real trace).
  skillDetector: skillFileReadDetector,
  // Forced mode (TODO §P1) uses the same lever as hermes, for the same reason:
  // pi-acp advertises no per-skill commands over ACP (no `available_commands_update`
  // in any captured pi stream), so there is no native `/skill:<name>` to send, and
  // prompt-level inlining reaches the model regardless of bridge internals. pi still
  // lists the copied skill in its system prompt, so it may *also* read SKILL.md —
  // harmless, and forced handles reject the discovery spy anyway.
  forceSkill: inlineSkillPrompt,
  async init({ env, config }): Promise<void> {
    const json = renderPiModelsJson(config)
    if (!json) return
    await env.writeFile(join(env.agentHome, 'models.json'), `${json}\n`)
  },
}
