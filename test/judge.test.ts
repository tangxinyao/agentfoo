import { describe, it, expect } from 'vitest'
import { normalizeRubric, defaultThreshold, judge } from '../src/judge.js'

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
    ).rejects.toThrow(/Unsupported judge provider "openai".*anthropic, deepseek/s)
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
