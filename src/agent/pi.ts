import { join } from 'node:path'
import type { AgentConfig } from '../types.js'
import type { AcpxSpec } from './acpx.js'
import { skillFileReadDetector } from '../skill.js'
import { resolveModelProvider } from './hermes.js'

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
 * `apiKey` is deliberately the **name** of an env var, not a key: pi resolves a
 * bare string as a variable name (a literal key and a `!command` are the other
 * two forms), so the secret keeps arriving through `passEnv` and never lands on
 * the container's disk.
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
        ...(apiKeyEnv ? { apiKey: apiKeyEnv } : {}),
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
  async init({ env, config }): Promise<void> {
    const json = renderPiModelsJson(config)
    if (!json) return
    await env.exec(['sh', '-c', `mkdir -p "${env.agentHome}"`])
    await env.exec([
      'sh',
      '-c',
      `cat > "${join(env.agentHome, 'models.json')}" <<'AGENTFOO_EOF'\n${json}\nAGENTFOO_EOF`,
    ])
  },
}
