import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeProvider } from '../src/agent/provider-probe.js'

const config = {
  model: 'deepseek/deepseek-v4-pro',
  baseUrl: 'https://api.deepseek.com',
  passEnv: ['DEEPSEEK_API_KEY'],
}
const creds = { DEEPSEEK_API_KEY: 'sk-test' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('probeProvider', () => {
  it('reports the status and body the provider rejected the key with', async () => {
    const fetch = vi.fn(async () => new Response('{"error":{"message":"Authentication Fails"}}', { status: 401 }))
    vi.stubGlobal('fetch', fetch)

    const msg = await probeProvider(config, creds)

    expect(msg).toMatch(/https:\/\/api\.deepseek\.com\/chat\/completions.*DEEPSEEK_API_KEY.*401.*Authentication Fails/)
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'deepseek-v4-pro', max_tokens: 1 })
  })

  it('points inside the agent when the provider accepts the credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    expect(await probeProvider(config, creds)).toMatch(/200 OK.*look inside the agent/)
  })

  it('says so without a request when no key is set at all', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await probeProvider(config, {})).toMatch(/no API key.*DEEPSEEK_API_KEY/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never throws on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND') }))
    expect(await probeProvider(config, creds)).toMatch(/failed from the host: getaddrinfo ENOTFOUND/)
  })
})
