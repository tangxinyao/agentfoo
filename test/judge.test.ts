import { describe, it, expect, afterEach, vi } from 'vitest'
import { normalizeRubric, defaultThreshold, judge } from '../src/judge.js'

/**
 * Stub one grading round-trip. Returns the captured request body so tests can
 * assert on what was actually sent (e.g. the output-token cap).
 */
function stubJudgeResponse(payload: unknown): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {}
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    captured = JSON.parse(String((init as RequestInit).body))
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { body: () => captured }
}

/** An OpenAI-dialect completion, as deepseek et al. return it. */
function openaiReply(content: string, finish = 'stop', reasoningTokens?: number) {
  return {
    choices: [{ message: { content }, finish_reason: finish }],
    usage: { completion_tokens_details: { reasoning_tokens: reasoningTokens } },
  }
}

describe('judge helpers', () => {
  it('normalizes a single string rubric to one weighted criterion', () => {
    expect(normalizeRubric('be polite')).toEqual([{ criteria: 'be polite', weight: 1 }])
  })

  it('defaults missing weights to 1', () => {
    expect(normalizeRubric([{ criteria: 'a' }, { criteria: 'b', weight: 3 }])).toEqual([
      { criteria: 'a', weight: 1 },
      { criteria: 'b', weight: 3 },
    ])
  })

  it('defaults the pass threshold to 1', () => {
    expect(defaultThreshold('anything')).toBe(1)
  })

  it('rejects unknown judge providers with a helpful message', async () => {
    await expect(
      judge('some text', 'be nice', { model: 'openai/gpt-5' }, 1),
    ).rejects.toThrow(/Unsupported judge provider "openai".*anthropic, deepseek, glm, minimax, kimi/s)
  })

  it('routes deepseek models to the DEEPSEEK_API_KEY var', async () => {
    const prev = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      await expect(
        judge('some text', 'be nice', { model: 'deepseek/deepseek-chat' }, 1),
      ).rejects.toThrow(/DEEPSEEK_API_KEY/)
    } finally {
      if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev
    }
  })

  it.each([
    ['glm/glm-4.6', ['ZHIPUAI_API_KEY', 'GLM_API_KEY']],
    ['minimax/minimax-m2', ['MINIMAX_API_KEY']],
    ['kimi/kimi-k2', ['MOONSHOT_API_KEY', 'KIMI_API_KEY']],
  ] as const)('routes %s to its conventional key env var(s)', async (model, keyVars) => {
    const prev = keyVars.map((k) => [k, process.env[k]] as const)
    for (const k of keyVars) delete process.env[k]
    try {
      // Error lists the first (primary) candidate var for the provider.
      await expect(judge('some text', 'be nice', { model }, 1)).rejects.toThrow(
        new RegExp(keyVars[0]),
      )
    } finally {
      for (const [k, v] of prev) if (v !== undefined) process.env[k] = v
    }
  })

  it('honors an explicit provider + apiKeyEnv override for a bare model', async () => {
    const prev = process.env.MY_GATEWAY_KEY
    delete process.env.MY_GATEWAY_KEY
    try {
      await expect(
        judge('t', 'c', { model: 'deepseek-chat', provider: 'deepseek', apiKeyEnv: 'MY_GATEWAY_KEY' }, 1),
      ).rejects.toThrow(/MY_GATEWAY_KEY/)
    } finally {
      if (prev !== undefined) process.env.MY_GATEWAY_KEY = prev
    }
  })
})

/**
 * Regression cover for the failure that motivated these: a reasoning judge
 * (deepseek-v4-pro) spent its entire 1024-token output budget on hidden
 * reasoning, so the grading call came back truncated or empty and surfaced only
 * as `Judge returned unparseable output: ` with nothing after the colon.
 */
describe('judge output-token budget', () => {
  const config = { model: 'deepseek/deepseek-v4-pro', apiKeyEnv: 'FAKE_JUDGE_KEY' }

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.FAKE_JUDGE_KEY
  })

  it('leaves reasoning models room by default', async () => {
    process.env.FAKE_JUDGE_KEY = 'k'
    const req = stubJudgeResponse(openaiReply('{"results":[{"met":true,"reason":"ok"}]}'))

    const result = await judge('transcript', 'be specific', config, 1)

    expect(result.passed).toBe(true)
    expect(req.body().max_tokens).toBe(32768)
  })

  it('honors an explicit judge.maxTokens', async () => {
    process.env.FAKE_JUDGE_KEY = 'k'
    const req = stubJudgeResponse(openaiReply('{"results":[{"met":true,"reason":"ok"}]}'))

    await judge('transcript', 'be specific', { ...config, maxTokens: 2048 }, 1)

    expect(req.body().max_tokens).toBe(2048)
  })

  it('names the token cap when the verdict is cut off mid-JSON', async () => {
    process.env.FAKE_JUDGE_KEY = 'k'
    stubJudgeResponse(openaiReply('{"results":[{"met":true,"reas', 'length', 935))

    await expect(judge('transcript', 'be specific', config, 1)).rejects.toThrow(
      /hit its 32768-token output cap \(935 of them on reasoning\).*judge\.maxTokens/s,
    )
  })

  it('explains an empty response instead of reporting unparseable output', async () => {
    process.env.FAKE_JUDGE_KEY = 'k'
    stubJudgeResponse(openaiReply('', 'stop', 1024))

    await expect(judge('transcript', 'be specific', config, 1)).rejects.toThrow(
      /returned an empty response \(1024 of them on reasoning\)/,
    )
  })

  it('reports malformed (but complete) JSON as malformed', async () => {
    process.env.FAKE_JUDGE_KEY = 'k'
    stubJudgeResponse(openaiReply('{"results": [oops]}'))

    await expect(judge('transcript', 'be specific', config, 1)).rejects.toThrow(
      /malformed JSON/,
    )
  })

  it('caps anthropic grading calls with the same budget', async () => {
    process.env.FAKE_JUDGE_KEY = 'k'
    const req = stubJudgeResponse({
      content: [{ type: 'text', text: '{"results":[{"met":true,"reason":"ok"}]}' }],
      stop_reason: 'end_turn',
    })

    await judge('t', 'c', { model: 'anthropic/claude-opus-4-8', apiKeyEnv: 'FAKE_JUDGE_KEY' }, 1)

    expect(req.body().max_tokens).toBe(32768)
  })

  it('surfaces anthropic max_tokens truncation too', async () => {
    process.env.FAKE_JUDGE_KEY = 'k'
    stubJudgeResponse({
      content: [{ type: 'text', text: '{"results":[{"met":tr' }],
      stop_reason: 'max_tokens',
    })

    await expect(
      judge('t', 'c', { model: 'anthropic/claude-opus-4-8', apiKeyEnv: 'FAKE_JUDGE_KEY' }, 1),
    ).rejects.toThrow(/output cap/)
  })
})
