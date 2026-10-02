import { describe, expect, it } from 'vitest'
import { createAgentPool, testNameOf } from '../src/fixtures.js'
import { registerAgent } from '../src/agent/registry.js'
import type { Agent, AgentBootOptions } from '../src/agent/types.js'

/** A registered no-op agent that exposes the test binding the pool gave it. */
const booted: Array<{ opts: AgentBootOptions; tornDown: boolean }> = []
registerAgent('pool-fake', {
  homeEnvVar: 'FAKE_HOME',
  dockerfile: 'none.Dockerfile',
  create(opts) {
    const rec = { opts, tornDown: false }
    booted.push(rec)
    return {
      workspacePath: opts.env.workspacePath,
      async init() {},
      async loadSkill() {
        throw new Error('unused')
      },
      async loadWorkspace() {
        return opts.env.workspacePath
      },
      async run() {
        throw new Error('unused')
      },
      reset() {},
      async teardown() {
        rec.tornDown = true
        await opts.env.teardown()
      },
    } as unknown as Agent
  },
})

const pool = (size: number) =>
  createAgentPool({ size, kind: 'pool-fake', override: { runtime: 'local' } })

const testOf = (agent: Agent) => booted.find((b) => b.opts.env.workspacePath === agent.workspacePath)!.opts

describe('createAgentPool', () => {
  it('boots lazily up to size and binds each agent to its borrower', async () => {
    booted.length = 0
    const p = pool(2)
    const a = await p.acquire('case a')
    const b = await p.acquire('case b')
    expect(booted).toHaveLength(2)
    expect(testOf(a).currentTest!()).toBe('case a')
    expect(testOf(b).currentTest!()).toBe('case b')

    p.release(a)
    expect(testOf(a).currentTest!()).toBeUndefined()
    // A released agent is reused and rebound rather than booting a third.
    const c = await p.acquire('case c')
    expect(c).toBe(a)
    expect(testOf(c).currentTest!()).toBe('case c')
    expect(booted).toHaveLength(2)

    await p.teardown()
    expect(booted.every((x) => x.tornDown)).toBe(true)
  })

  it('makes a borrower wait when every agent is out', async () => {
    booted.length = 0
    const p = pool(1)
    const a = await p.acquire('first')
    let second: Agent | undefined
    const waiting = p.acquire('second').then((x) => (second = x))
    await Promise.resolve()
    expect(second).toBeUndefined()

    p.release(a)
    await waiting
    expect(second).toBe(a)
    expect(testOf(a).currentTest!()).toBe('second')
    await p.teardown()
  })

  it('rejects a nonsensical size and a foreign release', async () => {
    expect(() => createAgentPool({ size: 0 })).toThrow(/size/)
    const p = pool(1)
    expect(() => p.release({} as Agent)).toThrow(/did not hand out/)
  })
})

describe('testNameOf', () => {
  it('matches currentTestName: suite chain below the file, joined by " > "', ({ task }) => {
    expect(testNameOf(task)).toBe(expect.getState().currentTestName)
  })

  it('handles a hand-built nested task', () => {
    const file = { name: 'x.spec.ts', filepath: '/x.spec.ts' }
    const suite = { name: 'group', suite: file }
    expect(testNameOf({ name: 'case', suite })).toBe('group > case')
  })
})

describe('concurrency config', () => {
  it('defaults to serial and lifts vitest maxConcurrency only when asked', async () => {
    const { defineConfig } = await import('../src/config.js')
    expect(defineConfig({}).test?.maxConcurrency).toBe(1)
    expect(defineConfig({ concurrency: 2 }).test?.maxConcurrency).toBe(2)
    // Still opt-in per test: nothing becomes concurrent unless marked `.concurrent`.
    expect(defineConfig({ concurrency: 2 }).test?.sequence?.concurrent).toBe(false)
  })
})

describe('--local agent version recording (TODO §P1.5)', () => {
  it('records the host binary version into the run dir', async () => {
    const { readAgentVersions, runDir } = await import('../src/artifacts.js')
    const { rmSync } = await import('node:fs')
    process.env.AGENTFOO_RUN_ID = `unit-ver-${Date.now()}`
    registerAgent('ver-fake', {
      homeEnvVar: 'FAKE_HOME',
      dockerfile: 'none.Dockerfile',
      versionArgv: ['sh', '-c', 'echo "fake-agent 1.2.3"; echo extra'],
      create: (opts) => ({ workspacePath: opts.env.workspacePath, async loadSkill() {}, async init() {}, async teardown() { await opts.env.teardown() } }) as unknown as Agent,
    })
    const p = createAgentPool({ size: 1, kind: 'ver-fake', override: { runtime: 'local' } })
    try {
      await p.acquire('x')
      expect(readAgentVersions()).toEqual({ 'ver-fake': 'fake-agent 1.2.3' })
    } finally {
      await p.teardown()
      rmSync(runDir(), { recursive: true, force: true })
      delete process.env.AGENTFOO_RUN_ID
    }
  })
})
