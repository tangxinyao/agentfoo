import { describe, it, expect } from 'vitest'
import { modelFlag, renderOpencodeConfig, extractOpencodeSessionId } from '../src/agent/opencode.js'

describe('opencode modelFlag', () => {
  it('reassembles a provider-prefixed model as provider/model', () => {
    expect(modelFlag({ model: 'glm/glm-4.6' })).toBe('glm/glm-4.6')
  })

  it('joins an explicit provider with a bare model', () => {
    expect(modelFlag({ model: 'glm-4.6', provider: 'glm' })).toBe('glm/glm-4.6')
  })

  it('passes a bare model through when no provider is known', () => {
    expect(modelFlag({ model: 'claude-sonnet-5' })).toBe('claude-sonnet-5')
  })

  it('is undefined with no model', () => {
    expect(modelFlag({ provider: 'glm' })).toBeUndefined()
  })
})

describe('renderOpencodeConfig', () => {
  it('registers a custom OpenAI-compatible provider for a base_url endpoint', () => {
    const json = renderOpencodeConfig({
      model: 'glm/glm-4.6',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      passEnv: ['GLM_API_KEY'],
    })
    expect(json).toBeDefined()
    const doc = JSON.parse(json!)
    expect(doc.provider.glm.options.baseURL).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(doc.provider.glm.options.apiKey).toBe('{env:GLM_API_KEY}')
    expect(doc.provider.glm.models).toHaveProperty('glm-4.6')
  })

  it('is undefined when there is no custom endpoint to configure', () => {
    expect(renderOpencodeConfig({ model: 'claude-sonnet-5' })).toBeUndefined()
  })
})

describe('extractOpencodeSessionId', () => {
  it.each([
    ['{"sessionID":"ses_123"}', 'ses_123'],
    ['{"session_id":"ses_456"}', 'ses_456'],
    ['{"session":{"id":"ses_789"}}', 'ses_789'],
  ])('pulls a session id from %s', (text, expected) => {
    expect(extractOpencodeSessionId(text)).toBe(expected)
  })

  it('is undefined when absent', () => {
    expect(extractOpencodeSessionId('no id here')).toBeUndefined()
  })
})
