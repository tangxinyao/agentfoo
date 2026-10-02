import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { __resetConfigCache, selectedAgentKind } from '../src/config-runtime.js'

/**
 * `-a/--agent` agent selection: the CLI writes AGENTFOO_AGENT, and
 * `selectedAgentKind()` is what `bootAgent()` (no explicit kind) resolves through.
 *
 * The interesting cases are the *refusals*. Guessing an agent would run the whole
 * suite against the wrong one, and the symptom — a skill that "stopped firing" —
 * looks exactly like a real skill regression, which is an expensive thing to
 * debug. So ambiguity and typos must throw rather than pick.
 */
describe('selectedAgentKind', () => {
  const saved = { config: process.env.AGENTFOO_CONFIG, agent: process.env.AGENTFOO_AGENT }

  function setConfig(agents: Record<string, unknown>): void {
    process.env.AGENTFOO_CONFIG = JSON.stringify({ agents })
    __resetConfigCache()
  }

  beforeEach(() => {
    delete process.env.AGENTFOO_AGENT
    __resetConfigCache()
  })

  afterEach(() => {
    if (saved.config === undefined) delete process.env.AGENTFOO_CONFIG
    else process.env.AGENTFOO_CONFIG = saved.config
    if (saved.agent === undefined) delete process.env.AGENTFOO_AGENT
    else process.env.AGENTFOO_AGENT = saved.agent
    __resetConfigCache()
  })

  it('defaults to the sole configured agent when no flag is given', () => {
    setConfig({ hermes: { model: 'deepseek-v4-pro' } })
    expect(selectedAgentKind()).toBe('hermes')
  })

  it('takes AGENTFOO_AGENT over the config default', () => {
    setConfig({ hermes: {}, opencode: {} })
    process.env.AGENTFOO_AGENT = 'opencode'
    expect(selectedAgentKind()).toBe('opencode')
  })

  it('rejects an agent that is not in the config, listing what is', () => {
    setConfig({ hermes: {}, opencode: {} })
    process.env.AGENTFOO_AGENT = 'openclaw'
    expect(() => selectedAgentKind()).toThrow(/no agent named "openclaw".*hermes, opencode/s)
  })

  it('refuses to guess when several agents are configured and none is selected', () => {
    setConfig({ hermes: {}, opencode: {} })
    expect(() => selectedAgentKind()).toThrow(/ambiguous.*2 agents.*-a <kind>/s)
  })

  it('errors with actionable advice when no agents are configured at all', () => {
    setConfig({})
    expect(() => selectedAgentKind()).toThrow(/declares no `agents`/)
  })

  it('allows any kind through when the config declares no agents (BYO registerAgent)', () => {
    // A `registerAgent`-registered agent may legitimately need no config block, so
    // the typo check only applies once `agents` is non-empty.
    setConfig({})
    process.env.AGENTFOO_AGENT = 'my-agent'
    expect(selectedAgentKind()).toBe('my-agent')
  })

  it('ignores surrounding whitespace from the shell', () => {
    setConfig({ hermes: {}, opencode: {} })
    process.env.AGENTFOO_AGENT = '  opencode  '
    expect(selectedAgentKind()).toBe('opencode')
  })

  it('treats an empty AGENTFOO_AGENT as unset rather than as an agent named ""', () => {
    setConfig({ hermes: {} })
    process.env.AGENTFOO_AGENT = ''
    expect(selectedAgentKind()).toBe('hermes')
  })
})
