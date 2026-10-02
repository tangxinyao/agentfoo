import { describe, it, expect } from 'vitest'
import { resolveModelProvider, renderConfigYaml, hermesAcpxSpec } from '../src/agent/hermes.js'
import { AcpxAgent } from '../src/agent/acpx.js'
import type { AgentConfig } from '../src/types.js'
import type { AgentBootOptions } from '../src/agent/types.js'
import type { ExecOptions, ExecResult, RuntimeEnv } from '../src/runtime/types.js'

describe('resolveModelProvider (F4: provider/model prefix)', () => {
  it('splits a provider-prefixed model into bare model + provider', () => {
    expect(resolveModelProvider({ model: 'deepseek/deepseek-v4-pro' })).toEqual({
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
    })
  })

  it('leaves a bare model untouched', () => {
    expect(resolveModelProvider({ model: 'claude-sonnet-5' })).toEqual({
      model: 'claude-sonnet-5',
      provider: undefined,
    })
  })

  it('lets an explicit provider win over the prefix (prefix still stripped)', () => {
    expect(
      resolveModelProvider({ model: 'deepseek/deepseek-v4-pro', provider: 'custom' }),
    ).toEqual({ model: 'deepseek-v4-pro', provider: 'custom' })
  })

  it('handles a model whose name itself contains a slash after the provider', () => {
    expect(resolveModelProvider({ model: 'openrouter/vendor/model-x' })).toEqual({
      model: 'vendor/model-x',
      provider: 'openrouter',
    })
  })

  it('is a no-op when no model is set', () => {
    expect(resolveModelProvider({ provider: 'deepseek' })).toEqual({
      model: undefined,
      provider: 'deepseek',
    })
  })
})

describe('renderConfigYaml with a provider/model prefix', () => {
  it('writes the split model + derived provider into config.yaml', () => {
    const yaml = renderConfigYaml({ model: 'deepseek/deepseek-v4-pro', baseUrl: 'https://api.deepseek.com' })
    expect(yaml).toContain('default: deepseek-v4-pro')
    expect(yaml).toContain('provider: deepseek')
    expect(yaml).toContain('base_url: https://api.deepseek.com')
  })

  it('disables memory by default so repeated runs stay reproducible', () => {
    expect(renderConfigYaml({ model: 'x' })).toContain('memory_enabled: false')
    expect(renderConfigYaml({ model: 'x', memory: true })).toContain('memory_enabled: true')
  })
})

/**
 * A RuntimeEnv stub recording exec argv. `route` supplies stdout per call; a
 * `sessions new` call is answered with a session-created banner by default.
 */
function fakeEnv(route: (argv: string[]) => Partial<ExecResult> = () => ({})): RuntimeEnv & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    id: 'test',
    workspacePath: '/workspace',
    skillsPath: '/skills',
    agentHome: '/home/hermes',
    async exec(argv: string[], _opts?: ExecOptions): Promise<ExecResult> {
      calls.push(argv)
      return { stdout: '', stderr: '', exitCode: 0, ...route(argv) }
    },
    async copyDir() {},
    async readFile() {
      return ''
    },
    async teardown() {},
  }
}

function boot(env: RuntimeEnv, config: AgentConfig = {}, currentTest?: () => string | undefined) {
  const opts: AgentBootOptions = { env, config, sourceTag: 'agentfoo-7', currentTest }
  return new AcpxAgent(hermesAcpxSpec, opts)
}

/** A minimal one-turn ACP stream so parseAcpxTrace yields a non-empty trace. */
const oneTurn = (text: string) =>
  `{"jsonrpc":"2.0","method":"session/update","params":{"update":{"content":{"text":${JSON.stringify(text)},"type":"text"},"sessionUpdate":"agent_message_chunk"}}}`

describe('hermesAcpxSpec.init', () => {
  it('creates HERMES_HOME and writes a config.yaml heredoc into it', async () => {
    const env = fakeEnv()
    const agent = boot(env, { model: 'deepseek/deepseek-v4', baseUrl: 'https://api.deepseek.com' })

    await agent.init()

    expect(env.calls[0]).toEqual(['sh', '-c', 'mkdir -p "/home/hermes"'])
    const write = env.calls[1]
    expect(write[0]).toBe('sh')
    expect(write[2]).toContain('cat > "/home/hermes/config.yaml"')
    expect(write[2]).toContain('default: deepseek-v4')
    expect(write[2]).toContain('provider: deepseek')
    expect(write[2]).toContain('base_url: https://api.deepseek.com')
    expect(write[2]).toContain('memory_enabled: false')
  })
})

describe('AcpxAgent driving hermes (cwd-session model)', () => {
  it('creates a cwd session then prompts via the --agent escape hatch, no -s', async () => {
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: oneTurn('the answer') } : {}))
    const agent = boot(env, { model: 'deepseek/deepseek-v4' })

    const trace = await agent.run('hello')

    // 1st exec: sessions new for the workspace cwd (via --agent 'hermes acp')
    expect(env.calls[0]).toEqual([
      'acpx', '--agent', 'hermes acp', '--cwd', '/workspace', 'sessions', 'new',
    ])
    // 2nd exec: the prompt turn — cwd-scoped, no -s, no --model (hermes uses config.yaml)
    expect(env.calls[1]).toEqual([
      'acpx', '--agent', 'hermes acp', '--cwd', '/workspace',
      '--approve-all', '--format', 'json', 'hello',
    ])
    expect(env.calls[1]).not.toContain('-s')
    expect(env.calls[1]).not.toContain('--model')
    expect(trace.finalMessage).toBe('the answer')
    expect(agent.traces).toHaveLength(1)
  })

  it('reuses the same cwd session across turns within one test (sessions new once)', async () => {
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: oneTurn('ok') } : {}))
    const agent = boot(env, {}, () => 'same-test')

    await agent.run('first')
    await agent.run('second')

    const newCalls = env.calls.filter((c) => c.includes('sessions') && c.includes('new'))
    expect(newCalls).toHaveLength(1)
    const prompts = env.calls.filter((c) => c.includes('--format'))
    expect(prompts).toHaveLength(2)
  })

  it('starts a fresh cwd session when the test boundary changes', async () => {
    let test = 'test-a'
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: oneTurn('ok') } : {}))
    const agent = boot(env, {}, () => test)

    await agent.run('a')
    test = 'test-b'
    await agent.run('b')

    const newCalls = env.calls.filter((c) => c.includes('sessions') && c.includes('new'))
    expect(newCalls).toHaveLength(2)
  })

  it('reset() forces a fresh session on the next run', async () => {
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: oneTurn('ok') } : {}))
    const agent = boot(env, {}, () => 'one-test')

    await agent.run('a')
    agent.reset()
    await agent.run('b')

    const newCalls = env.calls.filter((c) => c.includes('sessions') && c.includes('new'))
    expect(newCalls).toHaveLength(2)
  })

  it('throws when sessions new fails', async () => {
    const env = fakeEnv((argv) =>
      argv.includes('new') ? { exitCode: 1, stderr: 'no agent' } : {},
    )
    const agent = boot(env)
    await expect(agent.run('hello')).rejects.toThrow(/sessions new failed \(1\)\nno agent/)
  })

  it('surfaces a non-zero prompt exit with stderr', async () => {
    const env = fakeEnv((argv) =>
      argv.includes('--format') ? { exitCode: 2, stderr: 'boom' } : {},
    )
    const agent = boot(env)
    await expect(agent.run('hello')).rejects.toThrow(/acpx hermes exited 2\nboom/)
  })
})
