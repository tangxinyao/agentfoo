import { describe, it, expect } from 'vitest'
import { agentSpec, registerAgent } from '../src/agent/registry.js'
import { __resetConfigCache, resolveAgentConfig } from '../src/config-runtime.js'

describe('agentSpec registry', () => {
  it('maps hermes to the acpx adapter + HERMES_HOME + hermes Dockerfile', () => {
    const spec = agentSpec('hermes')
    expect(spec.homeEnvVar).toBe('HERMES_HOME')
    expect(spec.dockerfile).toBe('hermes.Dockerfile')
  })

  it('maps opencode to XDG_CONFIG_HOME + its own Dockerfile', () => {
    const spec = agentSpec('opencode')
    expect(spec.homeEnvVar).toBe('XDG_CONFIG_HOME')
    expect(spec.dockerfile).toBe('opencode.Dockerfile')
  })

  // Neither acpx-driven agent uses ACPX_HOME: acpx merely spawns the agent, and
  // it is the agent that reads its provider config and discovers skills under
  // its own state dir — pi's models.json under PI_CODING_AGENT_DIR, openclaw's
  // openclaw.json under OPENCLAW_STATE_DIR. Pointing those at the isolated home
  // is what puts skills at `RuntimeEnv.skillsPath` for free.
  it('gives pi and openclaw each their own config home', () => {
    const pi = agentSpec('pi')
    expect(pi.homeEnvVar).toBe('PI_CODING_AGENT_DIR')
    expect(pi.dockerfile).toBe('pi.Dockerfile')

    const openclaw = agentSpec('openclaw')
    expect(openclaw.homeEnvVar).toBe('OPENCLAW_STATE_DIR')
    expect(openclaw.dockerfile).toBe('openclaw.Dockerfile')
  })

  it('throws a helpful error listing registered kinds for an unknown kind', () => {
    expect(() => agentSpec('gemini')).toThrow(/Unknown agent kind "gemini".*hermes, opencode/s)
  })

  it('registerAgent adds a custom kind that agentSpec can then resolve', () => {
    const spec = {
      create: () => ({}) as never,
      homeEnvVar: 'MY_HOME',
      dockerfile: 'my.Dockerfile',
    }
    registerAgent('my-custom-agent', spec)
    expect(agentSpec('my-custom-agent')).toBe(spec)
  })
})

describe('resolveAgentConfig provider defaulting', () => {
  it('fills base_url + passEnv from a bare provider', () => {
    __resetConfigCache()
    const cfg = resolveAgentConfig('opencode', { provider: 'glm' })
    expect(cfg.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(cfg.passEnv).toEqual(['ZHIPUAI_API_KEY', 'GLM_API_KEY'])
  })

  it('derives the provider from a model prefix', () => {
    __resetConfigCache()
    const cfg = resolveAgentConfig('opencode', { model: 'kimi/kimi-k2' })
    expect(cfg.baseUrl).toBe('https://api.moonshot.cn/v1')
    expect(cfg.passEnv).toEqual(['MOONSHOT_API_KEY', 'KIMI_API_KEY'])
  })

  it('respects explicit baseUrl / passEnv over the provider defaults', () => {
    __resetConfigCache()
    const cfg = resolveAgentConfig('opencode', {
      provider: 'glm',
      baseUrl: 'https://gateway.internal/v1',
      passEnv: ['MY_KEY'],
    })
    expect(cfg.baseUrl).toBe('https://gateway.internal/v1')
    expect(cfg.passEnv).toEqual(['MY_KEY'])
  })

  it('leaves an unknown provider untouched', () => {
    __resetConfigCache()
    const cfg = resolveAgentConfig('hermes', { provider: 'mystery' })
    expect(cfg.baseUrl).toBeUndefined()
    expect(cfg.passEnv).toBeUndefined()
  })
})
