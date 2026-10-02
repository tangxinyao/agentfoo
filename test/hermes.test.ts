import { fileURLToPath } from 'node:url'
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
 * A RuntimeEnv stub recording exec argv (+ the env each call was given) and
 * copyDir calls. `route` supplies stdout per call; a `sessions new` call is
 * answered with a session-created banner by default.
 */
function fakeEnv(
  route: (argv: string[]) => Partial<ExecResult> = () => ({}),
): RuntimeEnv & { calls: string[][]; execEnvs: (Record<string, string> | undefined)[]; copies: [string, string][] } {
  const calls: string[][] = []
  const execEnvs: (Record<string, string> | undefined)[] = []
  const copies: [string, string][] = []
  return {
    calls,
    execEnvs,
    copies,
    id: 'test',
    workspacePath: '/workspace',
    skillsPath: '/skills',
    agentHome: '/home/hermes',
    homeEnvVar: 'HERMES_HOME',
    async exec(argv: string[], opts?: ExecOptions): Promise<ExecResult> {
      calls.push(argv)
      execEnvs.push(opts?.env)
      return { stdout: '', stderr: '', exitCode: 0, ...route(argv) }
    },
    async copyDir(hostSrc: string, dest: string) {
      copies.push([hostSrc, dest])
    },
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

/** A minimal one-turn ACP stream so parseAcpTrace yields a non-empty trace. */
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

    // hermes sets isolatePerTest (TODO §P0), so the first thing any test does
    // is provision itself a fresh --cwd + home before touching acpx at all:
    // 1st/2nd exec: mkdir the isolated cwd+skills dir, then hermesAcpxSpec.init
    // re-seeding config.yaml into the isolated home (3rd exec).
    const isolatedCwd = '/workspace/.agentfoo-tests/t1/ws'
    expect(env.calls[0]).toEqual([
      'sh', '-c', `mkdir -p "${isolatedCwd}" "/workspace/.agentfoo-tests/t1/home/skills"`,
    ])
    expect(env.calls[2][2]).toContain('cat > "/workspace/.agentfoo-tests/t1/home/config.yaml"')
    // 4th exec: the acpx host-resolution probe (TODO §P1.5 #3)
    expect(env.calls[3]).toEqual(['acpx', '--version'])
    // 5th exec: sessions new for the isolated cwd (via --agent 'hermes acp').
    // --ttl is short here (TODO §P0/§P1.5): a per-test queue-owner is never
    // reused past this test, so there's no reuse benefit to trade away by
    // letting it die quickly once idle — only the accumulation risk of a
    // teardown() that (real-machine confirmed) can never signal it directly.
    expect(env.calls[4]).toEqual([
      'acpx', '--agent', 'hermes acp', '--cwd', isolatedCwd, '--ttl', '30', 'sessions', 'new',
    ])
    // 6th exec: the prompt turn — cwd-scoped, no -s, no --model (hermes uses config.yaml)
    expect(env.calls[5]).toEqual([
      'acpx', '--agent', 'hermes acp', '--cwd', isolatedCwd, '--ttl', '30',
      '--approve-all', '--format', 'json', 'hello',
    ])
    expect(env.calls[5]).not.toContain('-s')
    expect(env.calls[5]).not.toContain('--model')
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
    // isolatePerTest (TODO §P0): the two `sessions new` calls must target
    // different --cwd values, not just be two calls against the same one —
    // that's the whole point, a new cwd is what forces a new hermes process.
    const cwdOf = (call: string[]) => call[call.indexOf('--cwd') + 1]
    expect(cwdOf(newCalls[0])).not.toBe(cwdOf(newCalls[1]))
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

  /**
   * The failure mode this guards against is a real one, observed on pi: an
   * unresolvable `apiKey` 401s, the ACP adapter answers `stopReason: end_turn`
   * with zero content, and acpx exits 0 — so without the check the run looks
   * successful and fails on whatever the spec asserts first.
   */
  it('throws when the agent exits 0 but produces no output at all', async () => {
    const endTurnOnly = '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}'
    const env = fakeEnv((argv) =>
      argv.includes('--format') ? { stdout: endTurnOnly, stderr: 'agent needs reconnect' } : {},
    )
    const agent = boot(env)

    await expect(agent.run('hello')).rejects.toThrow(
      /acpx hermes produced no output[\s\S]*provider wiring[\s\S]*agent needs reconnect/,
    )
  })

  it('still archives the empty session before throwing, so it can be diagnosed', async () => {
    const endTurnOnly = '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}'
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: endTurnOnly } : {}))
    const archived: string[] = []
    const agent = new AcpxAgent(hermesAcpxSpec, {
      env,
      config: {},
      sourceTag: 'agentfoo-7',
      onTrace: ({ sessionJsonl }) => archived.push(sessionJsonl),
    })

    await expect(agent.run('hello')).rejects.toThrow(/produced no output/)
    expect(archived.map((s) => s.trim())).toEqual([endTurnOnly])
  })

  // hermes fires a preloaded skill with no tool call and names it only in
  // `reasoning`, so a thought-only turn must not read as "no output".
  it('accepts a turn that emitted only reasoning', async () => {
    const thoughtOnly =
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":' +
      '{"content":{"text":"thinking about it","type":"text"},' +
      '"sessionUpdate":"agent_thought_chunk"}}}'
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: thoughtOnly } : {}))

    await expect(boot(env).run('hello')).resolves.toBeDefined()
  })
})

/**
 * §5: the reasoning-scan detector used to live in the example suite's
 * `setSkillDetector` — a per-worker global that would have graded a second
 * agent with hermes' signal. It is now the hermes adapter's own default, so the
 * handle hermes hands back detects a preloaded-skill firing on its own.
 */
describe('hermes skill detection (adapter default)', () => {
  it('counts a by-name mention in reasoning, with no tool call at all', async () => {
    const thought =
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":' +
      '{"content":{"text":"Let me load the frontend-design skill first.","type":"text"},' +
      '"sessionUpdate":"agent_thought_chunk"}}}'
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: thought } : {}))
    const agent = boot(env)

    const handle = await agent.loadSkill('/host/skills/frontend-design')
    const trace = await agent.run('design me a landing page')

    expect(trace.toolCalls).toHaveLength(0)
    expect(handle.calls()).toHaveLength(1)
    expect(handle.calls()[0].name).toBe('skill:frontend-design')
  })
})

/**
 * TODO §P0: `sessions new` alone doesn't stop hermes' cross-session
 * `session search` tool from reading a previous test's data out of the
 * shared home — real-machine reproduced by seeding a secret in one test and
 * having a later one search its own history back onto it. The fix gives
 * each test its own `--cwd` + home dir so a fresh hermes process never even
 * sees the previous test's session DB.
 */
describe('hermes isolatePerTest (TODO §P0)', () => {
  it('points HERMES_HOME at a fresh dir per test, not the boot-time agentHome', async () => {
    let test = 'test-a'
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: oneTurn('ok') } : {}))
    const agent = boot(env, {}, () => test)

    await agent.run('a')
    test = 'test-b'
    await agent.run('b')

    const promptEnvs = env.calls
      .map((call, i) => (call.includes('--format') ? env.execEnvs[i] : undefined))
      .filter((e): e is Record<string, string> => e !== undefined)
    expect(promptEnvs).toHaveLength(2)
    expect(promptEnvs[0].HERMES_HOME).not.toBe(promptEnvs[1].HERMES_HOME)
    // Neither test ever runs against the boot-time shared home — that's the
    // one hermes' session DB would leak across if this were still in use.
    expect(promptEnvs[0].HERMES_HOME).not.toBe('/home/hermes')
    expect(promptEnvs[1].HERMES_HOME).not.toBe('/home/hermes')
  })

  it('passes a short --ttl so an orphaned queue-owner cannot outlive teardown by the full 5min default', async () => {
    // Real-machine confirmed (TODO §P1.5): the queue-owner setsid-detaches, so
    // LocalEnv.teardown()'s process-group kill can never reach it — --ttl is
    // the only lever, and isolatePerTest spins up one queue-owner per test, so
    // leaving acpx's 300s default meant every test in a run left its own idle
    // hermes process resident for minutes after the file finished.
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: oneTurn('ok') } : {}))
    const agent = boot(env)

    await agent.run('hello')

    for (const call of env.calls.filter((c) => c.includes('--cwd'))) {
      expect(call).toContain('--ttl')
      expect(call[call.indexOf('--ttl') + 1]).toBe('30')
    }
  })

  it('re-copies an already-loaded skill into the next test\'s fresh home', async () => {
    let test = 'test-a'
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: oneTurn('ok') } : {}))
    const agent = boot(env, {}, () => test)

    await agent.loadSkill('/host/skills/frontend-design')
    await agent.run('a')
    const firstHome = env.copies.find(([, dest]) => dest.includes('frontend-design'))?.[1]

    test = 'test-b'
    await agent.run('b')
    const secondHome = env.copies
      .filter(([, dest]) => dest.includes('frontend-design'))
      .map(([, dest]) => dest)
      .at(-1)

    // Copied once at load time, then again when test-b's fresh home was
    // provisioned — same host source, a different destination each time.
    expect(env.copies.filter(([src]) => src === '/host/skills/frontend-design')).toHaveLength(2)
    expect(secondHome).not.toBe(firstHome)
  })

  it('loadWorkspace() throws instead of silently writing files a test will never see', async () => {
    const env = fakeEnv()
    const agent = boot(env)
    await expect(agent.loadWorkspace('/host/fixture')).rejects.toThrow(/isolatePerTest/)
  })
})

const frontendDesignDir = fileURLToPath(
  new URL('../example/skills/frontend-design', import.meta.url),
)

describe('hermes forced skill mode (TODO §P1)', () => {
  it('inlines the SKILL.md body ahead of the prompt on every run()', async () => {
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: oneTurn('ok') } : {}))
    const agent = boot(env)

    const handle = await agent.loadSkill(frontendDesignDir, { force: true })
    await agent.run('今天北京的天气怎么样？')

    const promptCall = env.calls.find((c) => c.includes('--format'))!
    const sentPrompt = promptCall.at(-1)!
    expect(sentPrompt).toContain('Approach this as the design lead')
    expect(sentPrompt).toContain('今天北京的天气怎么样？')
    // Forced injection happened before the frontmatter name marker too.
    expect(sentPrompt).toContain('name: frontend-design')
    expect(() => handle.calls()).toThrow(/force: true/)
  })

  it('reinjects on a second run() while the forced skill stays loaded', async () => {
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: oneTurn('ok') } : {}))
    const agent = boot(env, {}, () => 'same-test')

    await agent.loadSkill(frontendDesignDir, { force: true })
    await agent.run('first')
    await agent.run('second')

    const promptCalls = env.calls.filter((c) => c.includes('--format'))
    expect(promptCalls).toHaveLength(2)
    for (const call of promptCalls) {
      expect(call.at(-1)).toContain('Approach this as the design lead')
    }
  })
})
