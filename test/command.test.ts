import { describe, it, expect } from 'vitest'
import {
  CommandAgent,
  registerCommandAgent,
  type CommandAgentDef,
} from '../src/agent/command.js'
import { agentSpec } from '../src/agent/registry.js'
import type { AgentBootOptions } from '../src/agent/types.js'
import type { ExecOptions, ExecResult, RuntimeEnv } from '../src/runtime/types.js'
import { buildTrace } from '../src/trace.js'

/** A RuntimeEnv stub that records exec argv and returns a canned result. */
function fakeEnv(
  onExec: (argv: string[], opts?: ExecOptions) => ExecResult,
): RuntimeEnv & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    id: 'test',
    workspacePath: '/workspace',
    skillsPath: '/skills',
    agentHome: '/home',
    homeEnvVar: 'AGENT_HOME',
    async exec(argv, opts) {
      calls.push(argv)
      return onExec(argv, opts)
    },
    async writeFile(path: string, content: string) {
      calls.push(['writeFile', path, content])
    },
    async copyDir() {},
    async readFile() {
      return ''
    },
    async teardown() {},
  }
}

function boot(def: CommandAgentDef, env: RuntimeEnv, config: AgentBootOptions['config'] = {}) {
  return new CommandAgent(def, { env, config, sourceTag: 'agentfoo-test' })
}

/**
 * `parse` is required (TODO §IX.1/§P3): there is no default decoder, because a
 * wrong guess at a CLI's wire envelope yields an empty trace that then fails an
 * unrelated assertion. Most of these tests are about argv, session handling and
 * plumbing rather than decoding, so they share one trivial decoder; the two that
 * do care about parsing name their own.
 */
const nothingParsed = () => buildTrace([])

describe('CommandAgent', () => {
  it('builds argv from the definition, forwarding the resolved bare model', async () => {
    const env = fakeEnv(() => ({
      stdout: '{"role":"assistant","content":"hi there"}',
      stderr: '',
      exitCode: 0,
    }))
    const agent = boot(
      {
        run: ({ prompt, model }) => ['mycli', 'chat', prompt, ...(model ? ['-m', model] : [])],
        parse: (out) => buildTrace([JSON.parse(out) as unknown]),
      },
      env,
      { model: 'deepseek/deepseek-v4' },
    )

    const trace = await agent.run('hello')

    // provider prefix stripped for the bare `-m` value, like the built-in adapters
    expect(env.calls[0]).toEqual(['mycli', 'chat', 'hello', '-m', 'deepseek-v4'])
    expect(trace.finalMessage).toBe('hi there')
    expect(agent.traces).toHaveLength(1)
  })

  it('captures a session id and continues it on the next turn', async () => {
    const env = fakeEnv(() => ({ stdout: 'session: sess_42\n{"messages":[]}', stderr: '', exitCode: 0 }))
    const agent = boot(
      {
        run: ({ prompt, sessionId }) => ['x', prompt, ...(sessionId ? ['--resume', sessionId] : [])],
        extractSessionId: (out) => out.match(/session:\s*(\S+)/)?.[1],
        parse: nothingParsed,
      },
      env,
    )

    await agent.run('first')
    await agent.run('second')

    expect(env.calls[0]).toEqual(['x', 'first'])
    expect(env.calls[1]).toEqual(['x', 'second', '--resume', 'sess_42'])
  })

  it('uses a custom parser when supplied', async () => {
    const env = fakeEnv(() => ({ stdout: 'anything', stderr: '', exitCode: 0 }))
    const agent = boot(
      {
        run: () => ['x'],
        parse: () => buildTrace([{ role: 'assistant', content: 'parsed by me' }]),
      },
      env,
    )

    const trace = await agent.run('go')
    expect(trace.finalMessage).toBe('parsed by me')
  })

  it('refuses to boot a definition that names no parser', () => {
    const env = fakeEnv(() => ({ stdout: '', stderr: '', exitCode: 0 }))
    // The type requires `parse`; a JS consumer or a caller compiled against the
    // old default would still reach here, and used to fail deep inside a run
    // with "this.def.parse is not a function".
    const def = { run: () => ['x'] } as unknown as CommandAgentDef
    expect(() => boot(def, env)).toThrow(/`parse` is required/)
  })

  it('throws with stderr when the CLI exits non-zero', async () => {
    const env = fakeEnv(() => ({ stdout: '', stderr: 'boom', exitCode: 3 }))
    const agent = boot({ run: () => ['x'], parse: nothingParsed }, env)
    await expect(agent.run('go')).rejects.toThrow(/x exited 3\nboom/)
  })

  it('runs the optional init hook with the resolved model/provider', async () => {
    const env = fakeEnv(() => ({ stdout: '{}', stderr: '', exitCode: 0 }))
    let seen: { model?: string; provider?: string } | undefined
    const agent = boot(
      {
        run: () => ['x'],
        parse: nothingParsed,
        init: ({ model, provider }) => {
          seen = { model, provider }
        },
      },
      env,
      { model: 'glm/glm-4.6' },
    )
    await agent.init()
    expect(seen).toEqual({ model: 'glm-4.6', provider: 'glm' })
  })
})

describe('registerCommandAgent', () => {
  it('registers a resolvable spec with sensible home/dockerfile defaults', () => {
    registerCommandAgent('cmd-default', { run: () => ['x'], parse: nothingParsed })
    const spec = agentSpec('cmd-default')
    expect(spec.homeEnvVar).toBe('AGENT_HOME')
    // absent from the package on purpose → surfaces the actionable docker error
    expect(spec.dockerfile).toBe('cmd-default.Dockerfile')
  })

  it('honours an explicit homeEnvVar', () => {
    registerCommandAgent('cmd-custom', {
      run: () => ['x'],
      parse: nothingParsed,
      homeEnvVar: 'CMD_HOME',
    })
    expect(agentSpec('cmd-custom').homeEnvVar).toBe('CMD_HOME')
  })
})
