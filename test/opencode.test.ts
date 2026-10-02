import { describe, it, expect } from 'vitest'
import {
  OpencodeAgent,
  modelFlag,
  renderOpencodeConfig,
  extractOpencodeSessionId,
} from '../src/agent/opencode.js'
import type { AgentConfig } from '../src/types.js'
import type { AgentBootOptions } from '../src/agent/types.js'
import type { ExecResult, RuntimeEnv } from '../src/runtime/types.js'

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

/** RuntimeEnv stub recording exec argv; `stdout` answers every call. */
function fakeEnv(stdout = ''): RuntimeEnv & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    id: 'test',
    workspacePath: '/workspace',
    skillsPath: '/skills',
    agentHome: '/home/agent',
    async exec(argv: string[]): Promise<ExecResult> {
      calls.push(argv)
      return { stdout, stderr: '', exitCode: 0 }
    },
    async copyDir() {},
    async readFile() {
      return ''
    },
    async teardown() {},
  }
}

function boot(env: RuntimeEnv, config: AgentConfig = {}) {
  const opts: AgentBootOptions = { env, config, sourceTag: 'agentfoo-1' }
  return new OpencodeAgent(opts)
}

/**
 * A minimal but REAL-shaped `run --format json` line: the session id is a
 * top-level key on a part event, not a bare `{sessionID}` record. Shape matters
 * here — the parser now throws on a stream where nothing matches its envelope
 * (§IX.1), so a made-up stub would both fail and stop testing anything real.
 */
const SESSION_STDOUT =
  '{"type":"text","sessionID":"ses_abc","part":{"type":"text","text":"done"}}'

describe('OpencodeAgent run argv', () => {
  it('runs non-interactively with --format json --auto', async () => {
    // `--auto` (auto-approve permissions) is opencode's analogue of hermes'
    // --approve-all: without it a file-editing turn can block on a prompt with
    // no tty to answer it. Verified present on `opencode run` 1.18.5.
    const env = fakeEnv()
    await boot(env, { model: 'deepseek/deepseek-v4-pro' }).run('hello')

    expect(env.calls[0]).toEqual([
      'opencode', 'run', 'hello', '--format', 'json', '--auto',
      '--model', 'deepseek/deepseek-v4-pro',
    ])
  })

  it('continues the session on later turns, by id when one was captured', async () => {
    const env = fakeEnv(SESSION_STDOUT)
    const agent = boot(env)
    await agent.run('one')
    await agent.run('two')

    expect(env.calls[0]).not.toContain('--session')
    expect(env.calls[1].slice(-2)).toEqual(['--session', 'ses_abc'])
  })

  it('falls back to -c when the run output carries no session id', async () => {
    const env = fakeEnv('no id in here')
    const agent = boot(env)
    await agent.run('one')
    await agent.run('two')

    expect(env.calls[1]).toContain('-c')
    expect(env.calls[1]).not.toContain('--session')
  })

  it('starts a fresh session after reset() (per-test isolation, §4)', async () => {
    const env = fakeEnv(SESSION_STDOUT)
    const agent = boot(env)
    await agent.run('one')
    agent.reset()
    await agent.run('two')

    expect(env.calls[1]).not.toContain('--session')
    expect(env.calls[1]).not.toContain('-c')
  })
})
