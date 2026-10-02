import type { AgentConfig } from '../types.js'
import { providerMeta } from '../providers.js'
import { resolveModelProvider } from './hermes.js'

/**
 * When an agent turn comes back empty, ask the provider directly what it thinks
 * of this agent's credentials.
 *
 * Some ACP bridges swallow provider errors whole: DeepSeek answering a revoked
 * key with `401 Authentication Fails`, pi-acp turning that into
 * `stopReason: end_turn` with zero content, acpx exiting 0. All agentfoo can see
 * is a silent turn, and the generic "check your wiring" hint sent the first
 * debugging session through the adapter's config before anyone tried the key.
 * One minimal request with the same endpoint, key and model names the real cause
 * in the failure message itself.
 *
 * Sent from the host, not the container: good enough to tell "the key/model is
 * rejected" from "the provider accepts it, so the fault is inside the agent's own
 * config" — the two branches the silent-turn hint cannot split. Never throws.
 */
export async function probeProvider(
  config: AgentConfig,
  credentialEnv: Record<string, string>,
  timeoutMs = 15_000,
): Promise<string> {
  const { model, provider } = resolveModelProvider(config)
  const meta = provider ? providerMeta(provider) : undefined
  const dialect = meta?.dialect ?? 'openai'

  const keyVar = config.passEnv?.find((v) => credentialEnv[v]) ?? meta?.apiKeyEnv.find((v) => process.env[v])
  const key = keyVar ? (credentialEnv[keyVar] ?? process.env[keyVar]) : undefined
  if (!key) {
    return (
      `provider probe: no API key to test — none of passEnv (${(config.passEnv ?? []).join(', ') || 'unset'})` +
      ' is set on the host. The agent is running without credentials.'
    )
  }
  if (!model) return 'provider probe: skipped — no model configured.'

  let url: string
  let init: RequestInit
  if (dialect === 'anthropic') {
    url = config.baseUrl ? `${config.baseUrl.replace(/\/+$/, '')}/v1/messages` : meta!.judgeUrl
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    }
  } else {
    const base = config.baseUrl ?? meta?.apiBase
    if (!base) return `provider probe: skipped — no base URL known for provider "${provider ?? 'unset'}".`
    url = `${base.replace(/\/+$/, '')}/chat/completions`
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    }
  }

  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    if (res.ok) {
      return (
        `provider probe: POST ${url} with ${keyVar} and model "${model}" → ${res.status} OK from the host. ` +
        'The provider accepts these credentials, so look inside the agent: its config file, ' +
        'how it resolves the key reference, or network access from the container.'
      )
    }
    const body = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 300)
    return `provider probe: POST ${url} with ${keyVar} and model "${model}" → ${res.status}: ${body}`
  } catch (err) {
    return `provider probe: POST ${url} failed from the host: ${(err as Error).message}`
  }
}
