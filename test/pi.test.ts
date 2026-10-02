import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { piAcpxSpec, renderPiModelsJson, piModelFlag } from '../src/agent/pi.js'
import { AcpxAgent } from '../src/agent/acpx.js'
import { compactAcpStream, parseAcpTrace } from '../src/trace.js'
import { skillFileReadDetector } from '../src/skill.js'
import type { AgentConfig } from '../src/types.js'
import type { AgentBootOptions } from '../src/agent/types.js'
import type { ExecOptions, ExecResult, RuntimeEnv } from '../src/runtime/types.js'

/**
 * A real acpx/ACP stream from pi 0.73.1 + pi-acp 0.0.32, captured by running the
 * example suite's design prompt against a container with `frontend-design`
 * installed (2026-07-26). Line-sampled from the 16k-frame original — every
 * *shape* is verbatim, but the streamed text chunks are decimated, so assert on
 * structure here, never on prose (`finalMessage` is spliced nonsense by
 * construction). §IX.1: a fixture written against an imagined shape is how wrong
 * code gets to look verified.
 */
const piTrace = readFileSync(
  fileURLToPath(new URL('./fixtures/pi-acp-skill-read.jsonl', import.meta.url)),
  'utf8',
)

/**
 * A **contiguous, verbatim** slice of the same capture: pi's `write` tool_call,
 * its first 60 streaming frames, and the completed frame. Nothing is reordered
 * or edited, so the adjacency compaction relies on is the real adjacency. This
 * is the pathological case — in the full turn this one tool call accounted for
 * 102.2MB of 103.7MB, because every frame restates the entire file written so far.
 */
const piStreamedWrite = readFileSync(
  fileURLToPath(new URL('./fixtures/pi-acp-streamed-write.jsonl', import.meta.url)),
  'utf8',
)

const nonEmptyLines = (s: string) => s.split('\n').filter((l) => l.trim())

describe('renderPiModelsJson (pi models.json schema)', () => {
  it('registers a custom OpenAI-compatible provider with base_url + model', () => {
    const doc = JSON.parse(
      renderPiModelsJson({
        model: 'deepseek/deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com',
        passEnv: ['DEEPSEEK_API_KEY'],
      })!,
    )
    expect(doc.providers.deepseek).toEqual({
      baseUrl: 'https://api.deepseek.com',
      api: 'openai-completions',
      apiKey: '${DEEPSEEK_API_KEY}',
      models: [{ id: 'deepseek-v4-pro' }],
    })
  })

  // pi interpolates `${VAR}` in config values, which is what keeps the secret
  // arriving over passEnv instead of landing on disk. The `$` is load-bearing:
  // a bare name is taken as the literal key, and pi-acp reports the resulting
  // 401 as an empty `end_turn` turn rather than an error (see renderPiModelsJson).
  it('writes an env var reference, never the key value itself', () => {
    const json = renderPiModelsJson({
      model: 'deepseek/x',
      baseUrl: 'https://api.deepseek.com',
      passEnv: ['DEEPSEEK_API_KEY'],
    })!
    expect(json).toContain('"apiKey": "${DEEPSEEK_API_KEY}"')
    expect(json).not.toContain('sk-')
  })

  // A provider pi already knows authenticates from the env var alone; writing a
  // half-populated models.json over that would only shadow the built-in entry.
  it('returns undefined when there is no custom endpoint to configure', () => {
    expect(renderPiModelsJson({ model: 'anthropic/claude-sonnet-5' })).toBeUndefined()
    expect(renderPiModelsJson({ baseUrl: 'https://api.deepseek.com' })).toBeUndefined()
  })
})

describe('piModelFlag', () => {
  // models.json can define an id a built-in provider also offers, so the flag
  // stays provider-qualified rather than relying on pi's fuzzy matching.
  it('keeps the model provider-qualified', () => {
    expect(piModelFlag({ model: 'deepseek/deepseek-v4-pro' })).toBe('deepseek/deepseek-v4-pro')
    expect(piModelFlag({ model: 'deepseek-v4-pro', provider: 'deepseek' })).toBe(
      'deepseek/deepseek-v4-pro',
    )
  })

  it('falls back to a bare model when no provider is known, and omits when unset', () => {
    expect(piModelFlag({ model: 'gpt-5' })).toBe('gpt-5')
    expect(piModelFlag({})).toBeUndefined()
  })
})

function fakeEnv(
  route: (argv: string[]) => Partial<ExecResult> = () => ({}),
): RuntimeEnv & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    id: 'test',
    workspacePath: '/workspace',
    skillsPath: '/tmp/agenthome/skills',
    agentHome: '/tmp/agenthome',
    homeEnvVar: 'PI_CODING_AGENT_DIR',
    async exec(argv: string[], _opts?: ExecOptions): Promise<ExecResult> {
      calls.push(argv)
      return { stdout: '', stderr: '', exitCode: 0, ...route(argv) }
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

function boot(env: RuntimeEnv, config: AgentConfig = {}) {
  const opts: AgentBootOptions = { env, config, sourceTag: 'agentfoo-7' }
  return new AcpxAgent(piAcpxSpec, opts)
}

describe('piAcpxSpec.init', () => {
  it('writes models.json into PI_CODING_AGENT_DIR (the agent home)', async () => {
    const env = fakeEnv()
    const agent = boot(env, {
      model: 'deepseek/deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      passEnv: ['DEEPSEEK_API_KEY'],
    })

    await agent.init()

    expect(env.calls[0].slice(0, 2)).toEqual(['writeFile', '/tmp/agenthome/models.json'])
    expect(env.calls[0][2]).toContain('"baseUrl": "https://api.deepseek.com"')
  })

  it('writes nothing when the provider needs no custom endpoint', async () => {
    const env = fakeEnv()
    await boot(env, { model: 'anthropic/claude-sonnet-5' }).init()
    expect(env.calls).toHaveLength(0)
  })
})

describe('AcpxAgent driving pi', () => {
  // pi is a built-in acpx agent, so its name is a SUBCOMMAND and every top-level
  // option has to precede it — commander resolves globals first, and a misplaced
  // `pi` makes acpx fall back to its default agent and fail with "No acpx
  // session found" against a session it did create.
  it('puts every global before the `pi` subcommand token', async () => {
    const env = fakeEnv((argv) =>
      argv.includes('--format') ? { stdout: piTrace } : {},
    )
    const agent = boot(env, { model: 'deepseek/deepseek-v4-pro' })

    await agent.run('design me a landing page')

    // 1st exec: the acpx host-resolution probe (TODO §P1.5 #3)
    expect(env.calls[0]).toEqual(['acpx', '--version'])
    expect(env.calls[1]).toEqual(['acpx', '--cwd', '/workspace', 'pi', 'sessions', 'new'])
    expect(env.calls[2]).toEqual([
      'acpx', '--cwd', '/workspace', '--approve-all', '--format', 'json',
      '--model', 'deepseek/deepseek-v4-pro', 'pi', 'design me a landing page',
    ])
  })
})

describe('pi skill detection (adapter default)', () => {
  it('counts the read of the skill file as the firing, from a real trace', async () => {
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: piTrace } : {}))
    const agent = boot(env)

    const handle = await agent.loadSkill('/host/skills/frontend-design')
    await agent.run('design me a landing page')

    // Not a skill-named tool call: pi reads the file like any other file.
    expect(handle.calls()).toHaveLength(1)
    expect(handle.calls()[0].name).toBe('read')
  })

  it('keeps the negative case falsifiable — pi\'s other tools are not firings', () => {
    const trace = parseAcpTrace(piTrace)
    // The same turn also ran bash and write; only the SKILL.md read counts, so a
    // turn that merely uses tools cannot pass by accident.
    expect(trace.toolCalls.length).toBeGreaterThan(1)
    expect(skillFileReadDetector(trace, 'frontend-design')).toHaveLength(1)
    expect(skillFileReadDetector(trace, 'some-other-skill')).toHaveLength(0)
  })

  // pi lists every installed skill by name in its system prompt, so a model that
  // merely says the name has not necessarily opened the file. Requiring the path
  // or the file's own frontmatter is what keeps `toHaveBeenCalled` meaningful.
  it('does not count a bare mention of the skill name as a firing', () => {
    const mention = parseAcpTrace(
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":' +
        '{"content":{"text":"I could use the frontend-design skill here.","type":"text"},' +
        '"sessionUpdate":"agent_message_chunk"}}}',
    )
    expect(skillFileReadDetector(mention, 'frontend-design')).toHaveLength(0)
  })
})

/**
 * pi streams a tool's input token-by-token: the `tool_call` frame carries
 * `rawInput: {}` and the path materializes across later `tool_call_update`s. The
 * ACP mapper was written against hermes, which sends exactly one update per call
 * and always with content — so every one of pi's progress frames used to become
 * its own empty `tool` message. One real turn produced 8326 updates, of which 9
 * carried content, and `trace.text()` — the transcript the judge grades — came
 * out as 8318 blank `[tool]` blocks around the actual conversation.
 */
describe('parseAcpTrace against pi streamed tool inputs', () => {
  it('emits a tool message only for updates that carry content', () => {
    const trace = parseAcpTrace(piTrace)
    const toolMessages = trace.messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages.every((m) => m.content.trim().length > 0)).toBe(true)
  })

  it('backfills the streamed path onto the call that announced it empty', () => {
    const read = parseAcpTrace(piTrace).toolCalls.find((c) => c.name === 'read')!
    expect(read.arguments.rawInput).toEqual({
      path: '/tmp/agenthome/skills/frontend-design/SKILL.md',
    })
    expect(read.result).toContain('name: frontend-design')
  })
})

/**
 * Streaming a tool's arguments as *restated whole inputs* rather than deltas makes
 * stdout quadratic in the size of what the tool writes. The measured turn behind
 * these fixtures produced 103.7MB, 102.2MB of it one `write` re-transmitting a
 * single HTML file. `compactAcpStream` drops the superseded restatements.
 *
 * The invariant that makes this safe is not "it looks smaller" but that the
 * compacted stream **parses to exactly the same Trace** — asserted here on real
 * captures, and true of the full 103.7MB original (→ 1.6MB, 98.5% smaller).
 */
describe('compactAcpStream', () => {
  it('collapses a run of restating frames to the single most complete one', () => {
    const before = nonEmptyLines(piStreamedWrite)
    const after = nonEmptyLines(compactAcpStream(piStreamedWrite))
    // 53 consecutive partial-input frames become 1; the tool_call, the
    // empty-input status frames and the completed frame all survive.
    expect(before).toHaveLength(61)
    expect(after).toHaveLength(9)
  })

  it('produces an identical trace — the property that makes it safe', () => {
    for (const raw of [piTrace, piStreamedWrite]) {
      const a = parseAcpTrace(raw)
      const b = parseAcpTrace(compactAcpStream(raw))
      expect(b.messages).toEqual(a.messages)
      expect(b.toolCalls).toEqual(a.toolCalls)
      expect(b.text()).toEqual(a.text())
    }
  })

  // The completed frame carries only content/rawOutput and NO rawInput, so the
  // last restating frame is the only surviving record of what the tool was
  // called with. Keeping the first, or dropping the whole run, would lose it.
  it('keeps the most complete input, not the first', () => {
    const call = parseAcpTrace(compactAcpStream(piStreamedWrite)).toolCalls[0]
    const input = call.arguments.rawInput as { path?: string; content?: string }
    expect(input.path).toBe('/workspace/index.html')
    expect(input.content).toContain('<!DOCTYPE html>')
  })

  it('is idempotent', () => {
    const once = compactAcpStream(piStreamedWrite)
    expect(compactAcpStream(once)).toBe(once)
  })

  // Every hermes tool_call_update carries content, so there is nothing to
  // supersede — compaction must not touch a stream that does not restate.
  it('leaves a stream whose updates all carry content untouched', () => {
    const hermesShaped = [
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"content":[{"content":{"text":"$ ls","type":"text"},"type":"content"}],"kind":"execute","toolCallId":"tc-1","sessionUpdate":"tool_call"}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"content":[{"content":{"text":"a.txt","type":"text"},"type":"content"}],"status":"completed","toolCallId":"tc-1","sessionUpdate":"tool_call_update"}}}',
      '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}',
    ]
    expect(nonEmptyLines(compactAcpStream(hermesShaped.join('\n')))).toEqual(hermesShaped)
  })

  // Adjacency is the whole safety argument: a frame may only be dropped when the
  // very next frame supersedes it. Two tools streaming at once share no ordering
  // guarantee, so nothing is collapsed across them.
  it('never collapses across a different toolCallId', () => {
    const interleaved = [
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"a","rawInput":{"path":"/x"}}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"b","rawInput":{"path":"/y"}}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"a","rawInput":{"path":"/x2"}}}}',
    ]
    expect(nonEmptyLines(compactAcpStream(interleaved.join('\n')))).toEqual(interleaved)
  })

  it('passes through non-JSON banner lines rather than eating them', () => {
    const withBanner = '[acpx] agent: pi\n{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}'
    expect(compactAcpStream(withBanner)).toContain('[acpx] agent: pi')
  })
})

const frontendDesignDir = fileURLToPath(
  new URL('../example/skills/frontend-design', import.meta.url),
)

describe('pi forced skill mode (TODO §P1)', () => {
  const agentReply =
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":' +
    '{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}}'

  it('inlines SKILL.md ahead of the prompt and says where the skill lives', async () => {
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: agentReply } : {}))
    const agent = boot(env)

    const handle = await agent.loadSkill(frontendDesignDir, { force: true })
    await agent.run('今天北京的天气怎么样？')

    const sent = env.calls.find((c) => c.includes('--format'))!.at(-1)!
    expect(sent).toContain('name: frontend-design')
    expect(sent).toContain('/tmp/agenthome/skills/frontend-design')
    expect(sent.endsWith('今天北京的天气怎么样？')).toBe(true)
    expect(() => handle.calls()).toThrow(/force: true/)
  })

  // A file-scoped agent with a per-test skill fixture calls loadSkill once per
  // test; without dedup the Nth test's prompt carried N copies of SKILL.md.
  it('injects a skill once however many times it is force-loaded', async () => {
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: agentReply } : {}))
    const agent = boot(env)

    await agent.loadSkill(frontendDesignDir, { force: true })
    await agent.loadSkill(frontendDesignDir, { force: true })
    await agent.run('hello')

    const sent = env.calls.find((c) => c.includes('--format'))!.at(-1)!
    expect(sent.split('name: frontend-design')).toHaveLength(2)
  })
})

describe('per-turn timeout', () => {
  it('passes the limit down to exec and rejects naming the turn when it fires', async () => {
    const seen: Array<number | undefined> = []
    const env = fakeEnv((argv) => (argv.includes('--format') ? { stdout: '', stderr: 'still thinking', timedOut: true } : {}))
    const exec = env.exec.bind(env)
    env.exec = async (argv, opts) => {
      if (argv.includes('--format')) seen.push(opts?.timeoutMs)
      return exec(argv, opts)
    }
    const agent = boot(env)
    await expect(agent.run('写一篇很长的文章', { timeout: 90_000 })).rejects.toThrow(
      /acpx pi turn exceeded its 90s timeout and was killed: "写一篇很长的文章"[\s\S]*still thinking/,
    )
    expect(seen).toEqual([90_000])
  })
})
