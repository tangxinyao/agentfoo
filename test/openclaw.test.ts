import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  openclawAcpxSpec,
  renderOpenclawJson,
  OPENCLAW_GATEWAY_PORT,
} from '../src/agent/openclaw.js'
import { AcpxAgent } from '../src/agent/acpx.js'
import { compactAcpStream, parseAcpTrace } from '../src/trace.js'
import { skillFileReadDetector } from '../src/skill.js'
import type { AgentConfig } from '../src/types.js'
import type { AgentBootOptions } from '../src/agent/types.js'
import type { ExecOptions, ExecResult, RuntimeEnv } from '../src/runtime/types.js'

/**
 * Real, unedited acpx/ACP streams from openclaw 2026.7.1-2 + acpx 0.12.1,
 * captured by prompting a live container (2026-07-26). Both are short enough to
 * commit whole, so unlike the pi fixtures these are verbatim end to end and the
 * prose in them is the model's actual output.
 *
 * `skill-read` is the positive case: a design prompt against a container with
 * `frontend-design` installed. `unrelated` is the negative control — a trivial
 * file edit that uses tools but must not read any SKILL.md, which is what keeps
 * `toHaveBeenCalled` falsifiable rather than always-true.
 */
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}.jsonl`, import.meta.url)), 'utf8')

const openclawTrace = fixture('openclaw-acp-skill-read')
const openclawUnrelated = fixture('openclaw-acp-unrelated')

describe('renderOpenclawJson (openclaw.json schema)', () => {
  // Every field here was confirmed with `openclaw config validate` against the
  // pinned release; two of them were mis-guessed first and only that caught it.
  it('registers a custom OpenAI-compatible provider with baseUrl + model', () => {
    const doc = JSON.parse(
      renderOpenclawJson({
        model: 'deepseek/deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com',
        passEnv: ['DEEPSEEK_API_KEY'],
      }),
    )
    expect(doc.models.mode).toBe('merge')
    expect(doc.models.providers.deepseek).toEqual({
      baseUrl: 'https://api.deepseek.com',
      apiKey: '${DEEPSEEK_API_KEY}',
      api: 'openai-completions',
      // `name` is required alongside `id`; pi's schema lets it default, this
      // one rejects the entry outright ("models.0.name: Invalid input").
      models: [{ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }],
    })
  })

  // There is no `--model` flag on this route at all (the bridge rejects acpx's),
  // so if the config does not carry the model, nothing does.
  it('selects the model in-config, provider-qualified', () => {
    const doc = JSON.parse(renderOpenclawJson({ model: 'deepseek/deepseek-v4-pro' }))
    expect(doc.agents.defaults.model).toEqual({ primary: 'deepseek/deepseek-v4-pro' })
    expect(openclawAcpxSpec.modelFlag).toBeUndefined()
  })

  it('binds the gateway to loopback with no auth, on the port the bridge dials', () => {
    const doc = JSON.parse(renderOpenclawJson({}))
    // `auth` is an object, not a string — the first guess failed validation with
    // "gateway.auth: Invalid input".
    expect(doc.gateway).toEqual({
      mode: 'local',
      auth: { mode: 'none' },
      port: OPENCLAW_GATEWAY_PORT,
      bind: 'loopback',
    })
  })

  // Left enabled, the Gateway auto-FETCHES provider plugins from npm at startup:
  // a mid-test network dependency on whatever npm serves that day. An explicit
  // models.providers entry is sufficient without them (probed).
  it('disables plugin loading rather than allow-listing it', () => {
    const doc = JSON.parse(renderOpenclawJson({}))
    expect(doc.plugins).toEqual({ enabled: false })
    // The trap: an EMPTY allowlist means unrestricted, not "none" — openclaw
    // warns "plugins.allow is empty; discovered non-bundled plugins may
    // auto-load". So `allow` must not be the knob we reach for.
    expect(doc.plugins.allow).toBeUndefined()
  })

  // Bundled skills would sit next to the skill under test and muddy both the
  // trace and the detector.
  it('installs no bundled skills', () => {
    expect(JSON.parse(renderOpenclawJson({})).skills).toEqual({ allowBundled: [] })
  })

  // Reproducibility: openclaw otherwise indexes MEMORY.md into the state dir and
  // a later test can recall an earlier one's work. Same default as hermes.
  it('disables memory search unless memory is explicitly on', () => {
    expect(JSON.parse(renderOpenclawJson({})).agents.defaults.memorySearch).toEqual({
      enabled: false,
    })
    expect(
      JSON.parse(renderOpenclawJson({ memory: true })).agents.defaults.memorySearch,
    ).toEqual({ enabled: true })
  })

  // openclaw expands `${VAR}` at load time, which is what keeps the secret
  // arriving over passEnv instead of landing on the container's disk.
  it('writes an env var reference, never the key value itself', () => {
    const json = renderOpenclawJson({
      model: 'deepseek/x',
      baseUrl: 'https://api.deepseek.com',
      passEnv: ['DEEPSEEK_API_KEY'],
    })
    expect(json).toContain('"apiKey": "${DEEPSEEK_API_KEY}"')
    expect(json).not.toContain('sk-')
  })

  // Unlike pi's models.json, this file is never optional — the gateway stanza and
  // the model selection are needed even for a provider openclaw knows natively.
  it('still emits gateway + model config when there is no custom endpoint', () => {
    const doc = JSON.parse(renderOpenclawJson({ model: 'anthropic/claude-sonnet-5' }))
    expect(doc.models).toBeUndefined()
    expect(doc.gateway.port).toBe(OPENCLAW_GATEWAY_PORT)
    expect(doc.agents.defaults.model.primary).toBe('anthropic/claude-sonnet-5')
  })
})

function fakeEnv(
  route: (argv: string[]) => Partial<ExecResult> = () => ({}),
): RuntimeEnv & { calls: string[][]; execEnvs: (Record<string, string> | undefined)[] } {
  const calls: string[][] = []
  const execEnvs: (Record<string, string> | undefined)[] = []
  return {
    calls,
    execEnvs,
    id: 'test',
    workspacePath: '/workspace',
    skillsPath: '/tmp/agenthome/skills',
    agentHome: '/tmp/agenthome',
    homeEnvVar: 'OPENCLAW_STATE_DIR',
    async exec(argv: string[], opts?: ExecOptions): Promise<ExecResult> {
      calls.push(argv)
      execEnvs.push(opts?.env)
      return { stdout: '', stderr: '', exitCode: 0, ...route(argv) }
    },
    async copyDir() {},
    async readFile() {
      return ''
    },
    async teardown() {},
  }
}

function boot(env: RuntimeEnv, config: AgentConfig = {}) {
  const opts: AgentBootOptions = { env, config, sourceTag: 'agentfoo-7' }
  return new AcpxAgent(openclawAcpxSpec, opts)
}

describe('openclawAcpxSpec.init', () => {
  it('writes openclaw.json into OPENCLAW_STATE_DIR (the agent home)', async () => {
    const env = fakeEnv()
    await boot(env, {
      model: 'deepseek/deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      passEnv: ['DEEPSEEK_API_KEY'],
    }).init()

    expect(env.calls[0]).toEqual(['sh', '-c', 'mkdir -p "/tmp/agenthome"'])
    expect(env.calls[1][2]).toContain('cat > "/tmp/agenthome/openclaw.json"')
    expect(env.calls[1][2]).toContain('"baseUrl": "https://api.deepseek.com"')
  })

  /**
   * `openclaw acp` is only a bridge to a Gateway daemon nothing else starts, so
   * without this every run dies on `connect ECONNREFUSED 127.0.0.1:18789`.
   */
  it('starts the gateway detached and waits for the port', async () => {
    const env = fakeEnv()
    await boot(env, { model: 'deepseek/deepseek-v4-pro' }).init()

    const start = env.calls[2][2]
    expect(start).toContain('openclaw gateway')
    // RuntimeEnv.exec blocks, so the daemon needs its stdio fully detached or
    // init never returns.
    expect(start).toMatch(/nohup .*>.*2>&1 <\/dev\/null &$/)

    // Readiness is a real TCP connect: `openclaw health` exits 0 even with the
    // gateway down, so it cannot be the probe.
    const wait = env.calls[3][2]
    expect(wait).toContain(`connect(${OPENCLAW_GATEWAY_PORT}`)
    expect(wait).not.toContain('openclaw health')
  })

  // The Gateway, not the bridge, is the process that calls the model — a key
  // forwarded only to the acpx invocations would never reach it.
  it('forwards credentials to the gateway process', async () => {
    process.env.OPENCLAW_TEST_KEY = 'sk-test-not-a-real-key'
    try {
      const env = fakeEnv()
      await boot(env, { passEnv: ['OPENCLAW_TEST_KEY'] }).init()
      expect(env.execEnvs[2]).toEqual({ OPENCLAW_TEST_KEY: 'sk-test-not-a-real-key' })
    } finally {
      delete process.env.OPENCLAW_TEST_KEY
    }
  })

  it('fails loudly, with the gateway log, when the port never opens', async () => {
    const env = fakeEnv((argv) =>
      argv[2]?.includes('seq 1 60')
        ? { exitCode: 1, stdout: 'gateway did not listen\nEADDRINUSE' }
        : {},
    )
    await expect(boot(env).init()).rejects.toThrow(/gateway failed to start[\s\S]*EADDRINUSE/)
  })
})

/**
 * A dead Gateway reports only `agent needs reconnect` — which names neither the
 * daemon nor a reason, and reads like an adapter bug. Establishing that it was
 * really the host OOM killer took a rebuild and three live runs; `diagnose`
 * exists so the next person reads it off the first failure.
 */
describe('openclaw failure diagnostics', () => {
  it('reports a dead gateway, the likely cause, and the log tail', async () => {
    const env = fakeEnv((argv) => {
      if (argv.includes('--format')) {
        return { exitCode: 1, stderr: '[acpx] session cwd · /workspace · agent needs reconnect' }
      }
      // The diagnose exec: gateway port refuses, so its else-branch runs.
      if (argv[2]?.includes('tail -20')) {
        return {
          stdout:
            'gateway: NOT listening on 18789 — it died during the run.\n' +
            'The usual cause is the host OOM killer: the Gateway grows to ~850MB RSS,\n' +
            '--- /tmp/openclaw-gateway.log (tail) ---\n[gateway] ready\n',
        }
      }
      return {}
    })

    await expect(boot(env).run('design me a landing page')).rejects.toThrow(
      /agent needs reconnect[\s\S]*NOT listening[\s\S]*OOM killer[\s\S]*openclaw-gateway\.log/,
    )
  })

  it('checks the port rather than trusting `openclaw health`', async () => {
    const env = fakeEnv((argv) => (argv.includes('--format') ? { exitCode: 1 } : {}))
    await expect(boot(env).run('hi')).rejects.toThrow()

    const diag = env.calls.at(-1)![2]
    expect(diag).toContain(`connect(${OPENCLAW_GATEWAY_PORT}`)
    // `openclaw health` exits 0 with the gateway down — it reports the
    // pipeline, not the port, so it cannot answer the only question here.
    expect(diag).not.toContain('openclaw health')
  })

  // A diagnostic that throws would replace a real agent failure with a spurious
  // one, and the real one is the one worth seeing.
  it('never lets a broken diagnostic mask the failure it explains', async () => {
    const env = fakeEnv((argv) => {
      if (argv.includes('--format')) return { exitCode: 1, stderr: 'the real failure' }
      if (argv[2]?.includes('tail -20')) throw new Error('diagnostic blew up')
      return {}
    })
    await expect(boot(env).run('hi')).rejects.toThrow(/the real failure/)
  })
})

describe('AcpxAgent driving openclaw', () => {
  // openclaw is a built-in acpx agent, so its name is a SUBCOMMAND and every
  // top-level option has to precede it — commander resolves globals first.
  it('puts every global before the `openclaw` subcommand token', async () => {
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: openclawTrace } : {}))
    const agent = boot(env, { model: 'deepseek/deepseek-v4-pro' })

    await agent.run('design me a landing page')

    // 1st exec: the acpx host-resolution probe (TODO §P1.5 #3)
    expect(env.calls[0]).toEqual(['acpx', '--version'])
    expect(env.calls[1]).toEqual(['acpx', '--cwd', '/workspace', 'openclaw', 'sessions', 'new'])
    expect(env.calls[2]).toEqual([
      'acpx', '--cwd', '/workspace', '--approve-all', '--format', 'json',
      'openclaw', 'design me a landing page',
    ])
  })

  /**
   * Passing acpx's `--model` here is not merely redundant, it is fatal: the
   * bridge rejects it with "the ACP agent did not advertise model support …
   * and the adapter does not support a startup model flag". Worse, the choice is
   * sticky on the saved acpx session, so the error outlives dropping the flag
   * until a `sessions new`.
   */
  it('never passes --model, even when one is configured', async () => {
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: openclawTrace } : {}))
    await boot(env, { model: 'deepseek/deepseek-v4-pro' }).run('hi')
    expect(env.calls.flat()).not.toContain('--model')
  })
})

describe('openclaw skill detection (adapter default)', () => {
  it('counts the read of the skill file as the firing, from a real trace', async () => {
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: openclawTrace } : {}))
    const agent = boot(env)

    const handle = await agent.loadSkill('/host/skills/frontend-design')
    await agent.run('design me a landing page')

    // Not a skill-named tool call: openclaw reads the file like any other file.
    expect(handle.calls()).toHaveLength(1)
    expect(handle.calls()[0].name).toBe('read')
  })

  // The negative control is a real turn, not a hand-written one: it uses tools
  // for real, so a detector that fired on "the agent did something" would fail
  // here. That is the property that makes the positive case mean anything.
  it('keeps the negative case falsifiable', () => {
    const unrelated = parseAcpTrace(openclawUnrelated)
    expect(unrelated.toolCalls.length).toBeGreaterThan(0)
    expect(skillFileReadDetector(unrelated, 'frontend-design')).toHaveLength(0)

    const fired = parseAcpTrace(openclawTrace)
    expect(skillFileReadDetector(fired, 'frontend-design')).toHaveLength(1)
    expect(skillFileReadDetector(fired, 'some-other-skill')).toHaveLength(0)
  })
})

/**
 * openclaw rides the same ACP envelope as hermes and pi, so the point of these
 * is that {@link parseAcpTrace} needed no openclaw-specific branch — re-checked
 * against a real stream rather than assumed, since "it's ACP" is exactly the
 * assumption that hid pi's streamed-input problem.
 */
describe('parseAcpTrace against a real openclaw stream', () => {
  it('decodes the turn into alternating assistant/tool messages', () => {
    const trace = parseAcpTrace(openclawTrace)
    expect(trace.messages.map((m) => m.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant',
    ])
    expect(trace.toolCalls).toHaveLength(3)
    expect(trace.finalMessage).toContain('/workspace/coffee-landing.html')
  })

  /**
   * openclaw labels a tool call by ACP `kind`, not by the tool's own name — the
   * three calls in this turn are really `read`, `memory_search` and `write`, and
   * surface as `read`/`search`/`edit`. The real name survives only in `title`.
   * A detector matching on tool *name* therefore has to expect the kind
   * vocabulary; `skillFileReadDetector` matches on the path, which is why it is
   * unaffected either way.
   */
  it('names tool calls by ACP kind, with the real tool name in the title', () => {
    const calls = parseAcpTrace(openclawTrace).toolCalls
    expect(calls.map((c) => c.name)).toEqual(['read', 'search', 'edit'])
    expect(calls[1].arguments.title).toContain('memory_search:')
    expect(calls[2].arguments.title).toContain('write:')
  })

  it('backfills the read path and result onto the call', () => {
    const read = parseAcpTrace(openclawTrace).toolCalls.find((c) => c.name === 'read')!
    expect(read.arguments.rawInput).toEqual({
      path: '/tmp/agenthome/skills/frontend-design/SKILL.md',
    })
  })

  // openclaw sends one complete input per tool call rather than restating it per
  // token, so there is nothing to supersede. Asserted so a future openclaw that
  // starts streaming inputs shows up here instead of as a 100MB stdout.
  it('needs no compaction — inputs arrive complete', () => {
    for (const raw of [openclawTrace, openclawUnrelated]) {
      expect(compactAcpStream(raw)).toBe(raw)
    }
  })
})
