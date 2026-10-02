/**
 * Single source of truth for inference/judge providers.
 *
 * Two consumers read this registry:
 *  - the LLM judge ({@link file://./judge.ts}) routes a grading call by provider,
 *    using `judgeUrl` as the default endpoint and `apiKeyEnv` for auth;
 *  - agent config resolution ({@link file://./config-runtime.ts}) defaults an
 *    agent's OpenAI-compatible `baseUrl` from `apiBase` when a known provider is
 *    named without an explicit endpoint.
 *
 * Adding a provider is one entry here. Most Chinese-model providers speak the
 * OpenAI chat-completions dialect, so {@link openAiCompatible} keeps those entries
 * to a single line; only Anthropic needs its own (Messages API) wire format.
 */

export type ProviderDialect = 'anthropic' | 'openai'

export interface ProviderMeta {
  /** Conventional host env var(s) holding the API key, checked in order. */
  apiKeyEnv: string[]
  /** Full endpoint the judge POSTs a grading call to. */
  judgeUrl: string
  /**
   * Base URL (no endpoint path) for an agent's OpenAI-compatible client config,
   * e.g. hermes `model.base_url`. Undefined for providers an agent CLI already
   * has a built-in endpoint for (anthropic).
   */
  apiBase?: string
  /** Request/response wire format used by the judge. */
  dialect: ProviderDialect
}

/** Build an OpenAI-chat-completions-dialect entry from its endpoint + key vars. */
function openAiCompatible(
  apiKeyEnv: string[],
  judgeUrl: string,
  apiBase: string,
): ProviderMeta {
  return { apiKeyEnv, judgeUrl, apiBase, dialect: 'openai' }
}

export const PROVIDERS: Record<string, ProviderMeta> = {
  anthropic: {
    apiKeyEnv: ['ANTHROPIC_API_KEY'],
    judgeUrl: 'https://api.anthropic.com/v1/messages',
    dialect: 'anthropic',
  },

  // DeepSeek: OpenAI dialect, endpoint has no `/v1` segment.
  deepseek: openAiCompatible(
    ['DEEPSEEK_API_KEY'],
    'https://api.deepseek.com/chat/completions',
    'https://api.deepseek.com',
  ),

  // GLM (Zhipu / z.ai): OpenAI dialect under the paas/v4 path.
  glm: openAiCompatible(
    ['ZHIPUAI_API_KEY', 'GLM_API_KEY'],
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    'https://open.bigmodel.cn/api/paas/v4',
  ),

  // MiniMax: OpenAI-compatible chat-completions v2 endpoint. VERIFY-CLI: confirm
  // the endpoint path + JSON-mode support against a live key (MiniMax has both a
  // legacy proprietary API and this OpenAI-compatible one).
  minimax: openAiCompatible(
    ['MINIMAX_API_KEY'],
    'https://api.minimaxi.com/v1/text/chatcompletion_v2',
    'https://api.minimaxi.com/v1',
  ),

  // Kimi (Moonshot): OpenAI dialect under `/v1`.
  kimi: openAiCompatible(
    ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    'https://api.moonshot.cn/v1/chat/completions',
    'https://api.moonshot.cn/v1',
  ),
}

/** Provider metadata by name, or undefined if unknown. */
export function providerMeta(name: string): ProviderMeta | undefined {
  return PROVIDERS[name]
}
