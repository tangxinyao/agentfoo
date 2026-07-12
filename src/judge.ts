import type { JudgeConfig, JudgeResult, Rubric, RubricCriterion } from './types.js'

/**
 * LLM-as-judge scoring for `toSatisfy` (§5, §6).
 *
 * The judge model is a provider-prefixed string (`anthropic/claude-opus-4-8`,
 * `deepseek/deepseek-chat`, …). Routing goes through a small provider registry
 * ({@link PROVIDERS}) so each provider owns its endpoint, auth scheme, request
 * shape, response parsing, and conventional API-key env var. Adding a provider
 * is one registry entry; an unknown provider is rejected loudly rather than
 * silently mis-routed. `judge.baseUrl` / `judge.apiKeyEnv` let a known
 * provider's request shape be reused against a custom endpoint or key var
 * (e.g. an OpenAI-compatible gateway).
 */

/** Everything a provider needs to run one grading call and read its result. */
interface ProviderSpec {
  /** Conventional host env var(s) holding the API key, checked in order. */
  apiKeyEnv: string[]
  /** Endpoint used when the caller doesn't override it via `judge.baseUrl`. */
  defaultBaseUrl: string
  /** Build the HTTP request for a single grading call. */
  request(args: RequestArgs): { url: string; headers: Record<string, string>; body: unknown }
  /** Pull the assistant's text out of the parsed JSON response. */
  extractText(data: unknown): string
}

interface RequestArgs {
  baseUrl: string
  model: string
  system: string
  user: string
  apiKey: string
}

const PROVIDERS: Record<string, ProviderSpec> = {
  anthropic: {
    apiKeyEnv: ['ANTHROPIC_API_KEY'],
    defaultBaseUrl: 'https://api.anthropic.com/v1/messages',
    request: ({ baseUrl, model, system, user, apiKey }) => ({
      url: baseUrl,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: user }],
      },
    }),
    extractText(data) {
      const d = data as { content?: Array<{ type: string; text?: string }> }
      return (d.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
    },
  },

  // DeepSeek speaks the OpenAI chat-completions dialect: Bearer auth, a
  // `/chat/completions` endpoint, system-as-message, and `choices[].message`.
  // The same spec covers any OpenAI-compatible gateway via `judge.baseUrl`.
  deepseek: {
    apiKeyEnv: ['DEEPSEEK_API_KEY'],
    defaultBaseUrl: 'https://api.deepseek.com/chat/completions',
    request: ({ baseUrl, model, system, user, apiKey }) => ({
      url: baseUrl,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: {
        model,
        max_tokens: 1024,
        // JSON mode: the prompt asks for a JSON object, so constrain the output
        // to one for a parse we can trust. (DeepSeek requires "json" to appear
        // in the prompt, which the grader system message satisfies.)
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
    }),
    extractText(data) {
      const d = data as { choices?: Array<{ message?: { content?: string } }> }
      return d.choices?.[0]?.message?.content ?? ''
    },
  },
}

/** Default judge provider when the model string carries no prefix. */
const DEFAULT_PROVIDER = 'anthropic'

export function normalizeRubric(rubric: Rubric): RubricCriterion[] {
  const list = typeof rubric === 'string' ? [{ criteria: rubric, weight: 1 }] : rubric
  return list.map((c) => ({ criteria: c.criteria, weight: c.weight ?? 1 }))
}

/** Default threshold: single string rubric must fully pass; weighted defaults to all. */
export function defaultThreshold(rubric: Rubric): number {
  return 1
}

export async function judge(
  target: string,
  rubric: Rubric,
  config: JudgeConfig,
  threshold: number,
): Promise<JudgeResult> {
  const criteria = normalizeRubric(rubric)

  const providerName = config.provider ?? providerOf(config.model) ?? DEFAULT_PROVIDER
  const spec = PROVIDERS[providerName]
  if (!spec) {
    throw new Error(
      `Unsupported judge provider "${providerName}" (model "${config.model}"). ` +
        `Supported providers: ${Object.keys(PROVIDERS).join(', ')}. ` +
        `Set judge.model to a "<provider>/<model>" string, or judge.provider explicitly.`,
    )
  }

  const apiKey = resolveApiKey(config, spec, providerName)
  const baseUrl = config.baseUrl ?? spec.defaultBaseUrl
  const model = stripProvider(config.model)
  const breakdown = await scoreCriteria(target, criteria, { spec, baseUrl, model, apiKey })

  const totalWeight = criteria.reduce((s, c) => s + (c.weight ?? 1), 0)
  const metWeight = breakdown.reduce((s, b) => s + (b.met ? b.weight : 0), 0)
  const score = totalWeight === 0 ? 0 : metWeight / totalWeight

  return { passed: score >= threshold, score, threshold, breakdown }
}

/** Find the API key from the configured (or provider-default) env var(s). */
function resolveApiKey(config: JudgeConfig, spec: ProviderSpec, providerName: string): string {
  const candidates = config.apiKeyEnv ? [config.apiKeyEnv] : spec.apiKeyEnv
  for (const name of candidates) {
    const value = process.env[name]
    if (value) return value
  }
  throw new Error(
    `toSatisfy needs an LLM judge but the ${providerName} API key is not set. ` +
      `Export ${candidates.join(' or ')} (e.g. \`export ${candidates[0]}=...\`) before running agentfoo.`,
  )
}

async function scoreCriteria(
  target: string,
  criteria: RubricCriterion[],
  route: { spec: ProviderSpec; baseUrl: string; model: string; apiKey: string },
): Promise<JudgeResult['breakdown']> {
  const system =
    'You are a strict but fair grader for AI agent test assertions. ' +
    'Given a transcript and a list of criteria, decide for each whether the ' +
    'transcript MEETS it. Judge semantic intent, not exact wording: paraphrases ' +
    'that preserve meaning should pass. Respond with ONLY a JSON object of the ' +
    'form {"results":[{"met":boolean,"reason":string}]} in the same order as the ' +
    'criteria given. No prose outside the JSON.'

  const user =
    `# Transcript under test\n\n${target}\n\n` +
    `# Criteria (grade each in order)\n` +
    criteria.map((c, i) => `${i + 1}. ${c.criteria}`).join('\n')

  const { spec, baseUrl, model, apiKey } = route
  const req = spec.request({ baseUrl, model, system, user, apiKey })
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Judge API call failed (${res.status}): ${body.slice(0, 500)}`)
  }

  const data = await res.json()
  const text = spec.extractText(data)

  const parsed = parseJudgeJson(text)
  return criteria.map((c, i) => ({
    criteria: c.criteria,
    weight: c.weight ?? 1,
    met: parsed[i]?.met ?? false,
    reason: parsed[i]?.reason ?? 'no verdict returned',
  }))
}

function parseJudgeJson(text: string): Array<{ met: boolean; reason: string }> {
  // Be tolerant of code fences / stray prose around the JSON object.
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`Judge returned unparseable output: ${text.slice(0, 300)}`)
  const obj = JSON.parse(match[0]) as { results?: Array<{ met?: boolean; reason?: string }> }
  return (obj.results ?? []).map((r) => ({ met: !!r.met, reason: r.reason ?? '' }))
}

function providerOf(model: string): string | undefined {
  return model.includes('/') ? model.split('/')[0] : undefined
}

function stripProvider(model: string): string {
  return model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
}
