import type { JudgeConfig, JudgeResult, Rubric, RubricCriterion } from './types.js'
import { PROVIDERS as PROVIDER_META, type ProviderDialect } from './providers.js'

/**
 * LLM-as-judge scoring for `toSatisfy` (§5, §6).
 *
 * The judge model is a provider-prefixed string (`anthropic/claude-opus-4-8`,
 * `deepseek/deepseek-chat`, …). Routing goes through the shared provider registry
 * ({@link file://./providers.ts}): that module owns each provider's endpoint,
 * conventional API-key env var, and wire dialect, and this file owns the two
 * dialect request/response shapes ({@link DIALECTS}). Adding a provider is one
 * entry in `providers.ts`; an unknown provider is rejected loudly rather than
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
  /** Pull the assistant's text (and why generation stopped) out of the response. */
  extractOutput(data: unknown): JudgeOutput
}

interface RequestArgs {
  baseUrl: string
  model: string
  system: string
  user: string
  apiKey: string
  maxTokens: number
}

/**
 * What one grading call produced. `truncated` matters as much as `text`: a
 * reasoning judge that runs out of output budget returns a half-written (or
 * completely empty) JSON object, and the difference between "the model refused"
 * and "the model was cut off" is the difference between a useful error and a
 * baffling one.
 */
interface JudgeOutput {
  text: string
  /** True when generation stopped on the token cap rather than on its own. */
  truncated: boolean
  /** Tokens the model spent thinking, when the provider reports it. */
  reasoningTokens?: number
}

/** Request/response builders keyed by wire dialect. */
const DIALECTS: Record<ProviderDialect, Pick<ProviderSpec, 'request' | 'extractOutput'>> = {
  anthropic: {
    request: ({ baseUrl, model, system, user, apiKey, maxTokens }) => ({
      url: baseUrl,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      },
    }),
    extractOutput(data) {
      const d = data as {
        content?: Array<{ type: string; text?: string }>
        stop_reason?: string
      }
      const text = (d.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      return { text, truncated: d.stop_reason === 'max_tokens' }
    },
  },

  // The OpenAI chat-completions dialect: Bearer auth, a `/chat/completions`-style
  // endpoint, system-as-message, and `choices[].message`. Covers deepseek, glm,
  // minimax, kimi, and any OpenAI-compatible gateway via `judge.baseUrl`.
  openai: {
    request: ({ baseUrl, model, system, user, apiKey, maxTokens }) => ({
      url: baseUrl,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: {
        model,
        max_tokens: maxTokens,
        // JSON mode: the prompt asks for a JSON object, so constrain the output
        // to one for a parse we can trust. (DeepSeek et al. require "json" to
        // appear in the prompt, which the grader system message satisfies.)
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
    }),
    extractOutput(data) {
      const d = data as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
        usage?: { completion_tokens_details?: { reasoning_tokens?: number } }
      }
      const choice = d.choices?.[0]
      return {
        text: choice?.message?.content ?? '',
        truncated: choice?.finish_reason === 'length',
        reasoningTokens: d.usage?.completion_tokens_details?.reasoning_tokens,
      }
    },
  },
}

/** Judge routing specs, assembled from the shared provider metadata + dialects. */
const PROVIDERS: Record<string, ProviderSpec> = Object.fromEntries(
  Object.entries(PROVIDER_META).map(([name, meta]) => [
    name,
    { apiKeyEnv: meta.apiKeyEnv, defaultBaseUrl: meta.judgeUrl, ...DIALECTS[meta.dialect] },
  ]),
)

/** Default judge provider when the model string carries no prefix. */
const DEFAULT_PROVIDER = 'anthropic'

/**
 * Default output-token budget for a grading call.
 *
 * Note this caps *output* only — a large transcript costs prompt tokens, not
 * this budget. What actually consumes it is a reasoning judge charging its
 * chain-of-thought here alongside the verdict JSON (measured on deepseek-v4-pro:
 * ~300–1000 reasoning tokens against 4–16KB transcripts, growing with transcript
 * size and criteria count). At 1024 those models truncate mid-JSON or return
 * nothing at all, so this leaves roughly 30x the observed burn. Unused budget is
 * not billed.
 *
 * Lower it via `judge.maxTokens` if a provider enforces
 * `prompt + max_tokens <= context window` and your transcripts are large, or if
 * your judge model caps output below this (some older Anthropic models allow
 * 4096/8192 and reject anything higher outright).
 */
const DEFAULT_MAX_TOKENS = 32_768

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
  const breakdown = await scoreCriteria(target, criteria, resolveRoute(config))

  const totalWeight = criteria.reduce((s, c) => s + (c.weight ?? 1), 0)
  const metWeight = breakdown.reduce((s, b) => s + (b.met ? b.weight : 0), 0)
  const score = totalWeight === 0 ? 0 : metWeight / totalWeight

  return { passed: score >= threshold, score, threshold, breakdown }
}

type Route = { spec: ProviderSpec; baseUrl: string; model: string; apiKey: string; maxTokens: number }

/** Resolve a `provider/model` config into everything needed to send one request. */
function resolveRoute(config: JudgeConfig): Route {
  const providerName = config.provider ?? providerOf(config.model) ?? DEFAULT_PROVIDER
  const spec = PROVIDERS[providerName]
  if (!spec) {
    throw new Error(
      `Unsupported judge provider "${providerName}" (model "${config.model}"). ` +
        `Supported providers: ${Object.keys(PROVIDERS).join(', ')}. ` +
        `Set judge.model to a "<provider>/<model>" string, or judge.provider explicitly.`,
    )
  }
  return {
    spec,
    apiKey: resolveApiKey(config, spec, providerName),
    baseUrl: config.baseUrl ?? spec.defaultBaseUrl,
    model: stripProvider(config.model),
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
  }
}

/** One system+user request through a resolved route; returns the model's (JSON) text. */
async function send(route: Route, system: string, user: string): Promise<string> {
  const { spec, baseUrl, model, apiKey, maxTokens } = route
  const req = spec.request({ baseUrl, model, system, user, apiKey, maxTokens })
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Judge API call failed (${res.status}): ${body.slice(0, 500)}`)
  }

  const output = spec.extractOutput(await res.json())
  assertUsableOutput(output, model, maxTokens)
  return output.text
}

/**
 * A single JSON-mode completion through the judge's provider routing, for other
 * model roles that want the same endpoints, keys and failure messages — the
 * `agentfoo suggest` optimizer. `system` must mention JSON (OpenAI-dialect JSON
 * mode requires it). Returns the parsed object.
 */
export async function completeJson<T = unknown>(config: JudgeConfig, system: string, user: string): Promise<T> {
  const text = await send(resolveRoute(config), system, user)
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`Model returned no JSON object: ${text.slice(0, 300)}`)
  return JSON.parse(match[0]) as T
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
  route: Route,
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

  // A verdict list that is short, or has blank entries, used to be read as
  // "unmet" for every missing criterion — which failed a sound answer on four
  // negative criteria the judge simply never filled in (seen once in 272 verdicts
  // on deepseek-v4-pro). An incomplete grading is a judge fault, not a verdict:
  // ask again once, then fail loudly.
  let parsed = parseJudgeJson(await send(route, system, user))
  if (incomplete(parsed, criteria.length)) parsed = parseJudgeJson(await send(route, system, user))
  if (incomplete(parsed, criteria.length)) {
    const filled = parsed.filter((p) => p.reason.trim()).length
    throw new Error(
      `Judge "${route.model}" returned ${filled} usable verdicts for ${criteria.length} criteria, twice. ` +
        'Not grading on a partial answer — rerun, or split the rubric into fewer criteria per call.',
    )
  }
  return criteria.map((c, i) => ({
    criteria: c.criteria,
    weight: c.weight ?? 1,
    met: parsed[i].met,
    reason: parsed[i].reason,
  }))
}

/**
 * Fail loudly on the two ways a grading call comes back useless before we blame
 * the JSON parser for it. Hitting the token cap is by far the most common — a
 * reasoning judge spends its whole budget thinking and returns an empty string,
 * which as a bare "unparseable output: " tells the reader nothing about the
 * actual cause or the one-line fix.
 */
function assertUsableOutput(output: JudgeOutput, model: string, maxTokens: number): void {
  const spentThinking =
    output.reasoningTokens !== undefined ? ` (${output.reasoningTokens} of them on reasoning)` : ''

  if (output.truncated) {
    throw new Error(
      `Judge model "${model}" hit its ${maxTokens}-token output cap${spentThinking} before ` +
        `finishing the verdict JSON. Raise judge.maxTokens in agentfoo.config.ts, or pick a ` +
        `judge model that doesn't spend its output budget on reasoning.`,
    )
  }

  if (!output.text.trim()) {
    throw new Error(
      `Judge model "${model}" returned an empty response${spentThinking}. If this model emits ` +
        `reasoning, raise judge.maxTokens (currently ${maxTokens}); otherwise check that the ` +
        `model id is valid for this provider.`,
    )
  }
}

/** Fewer verdicts than criteria, or any verdict without a reason. */
function incomplete(parsed: Array<{ reason: string }>, n: number): boolean {
  return parsed.length < n || parsed.slice(0, n).some((p) => !p.reason.trim())
}

function parseJudgeJson(text: string): Array<{ met: boolean; reason: string }> {
  // Be tolerant of code fences / stray prose around the JSON object.
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`Judge returned unparseable output: ${text.slice(0, 300)}`)
  let obj: { results?: Array<{ met?: boolean; reason?: string }> }
  try {
    obj = JSON.parse(match[0])
  } catch (err) {
    throw new Error(
      `Judge returned malformed JSON (${(err as Error).message}): ${text.slice(0, 300)}`,
    )
  }
  return (obj.results ?? []).map((r) => ({ met: !!r.met, reason: r.reason ?? '' }))
}

function providerOf(model: string): string | undefined {
  return model.includes('/') ? model.split('/')[0] : undefined
}

function stripProvider(model: string): string {
  return model.includes('/') ? model.slice(model.indexOf('/') + 1) : model
}
