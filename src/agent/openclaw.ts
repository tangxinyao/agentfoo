import { join } from 'node:path'
import type { AgentConfig } from '../types.js'
import type { RuntimeEnv } from '../runtime/types.js'
import type { AcpxSpec } from './acpx.js'
import { skillFileReadDetector } from '../skill.js'
import { resolveModelProvider } from './hermes.js'
import { progress } from '../progress.js'
import { inlineSkillPrompt } from './shared.js'

/**
 * OpenClaw (https://docs.openclaw.ai) driven through the acpx ACP client as the
 * built-in `openclaw` agent, i.e. `acpx --cwd <ws> openclaw …` — the same
 * cwd-session model as hermes and pi, so it reuses {@link file://./acpx.ts
 * AcpxAgent} wholesale and differs only in this spec.
 *
 * Verified against a real openclaw 2026.7.1-2 + acpx 0.12.1 container: a prompt
 * turn returns exit 0, reads the installed SKILL.md, writes files for real, and
 * streams the ACP envelope {@link parseAcpTrace} already decodes unchanged
 * ({@link compactAcpStream} is a no-op — openclaw sends complete tool inputs).
 *
 * Four things about openclaw are load-bearing and cost a probe each to learn:
 *
 * 1. **`openclaw acp` is a bridge, not the agent.** It forwards over a WebSocket
 *    to a separate long-running **Gateway** daemon on 127.0.0.1:18789, which is
 *    the process that actually holds the model. Nothing starts it implicitly, so
 *    without {@link startGateway} every run dies on
 *    `ACP bridge failed: connect ECONNREFUSED 127.0.0.1:18789`. hermes and pi
 *    need no such daemon.
 * 2. **There is no `--model` flag** — hence no {@link AcpxSpec.modelFlag} here.
 *    The bridge rejects acpx's generic flag outright ("the ACP agent did not
 *    advertise model support … and the adapter does not support a startup model
 *    flag"), so the model is selected in the config file, via
 *    `agents.defaults.model.primary`.
 * 3. **Config lives in `$OPENCLAW_STATE_DIR`** — which is why that, not
 *    `ACPX_HOME`, is the kind's `homeEnvVar`. Pointing it at the runtime's
 *    isolated home puts both things openclaw needs where the runtime already
 *    puts them: `openclaw.json` at its root and priority-4 "managed" skills
 *    under `skills/<name>/SKILL.md`, which is `RuntimeEnv.skillsPath` unchanged.
 *    Its skills watcher picks up a directory copied in after boot, so
 *    `loadSkill()` needs no restart.
 * 4. **Plugins must be off.** Left enabled, the Gateway auto-*fetches* provider
 *    plugins from npm at startup — the same mid-test-npm-fetch hazard the pinned
 *    `pi-acp` install closes. An explicit `models.providers` entry is sufficient
 *    on its own (probed), so {@link renderOpenclawJson} disables plugin loading
 *    entirely. Note `plugins.allow: []` does NOT do this: an empty allowlist
 *    means *unrestricted*. `plugins.enabled: false` is the real knob.
 *
 * OPERATIONAL NOTE — **this agent needs a big host.** The Gateway grows to
 * ~850MB RSS during a single design turn, with zero plugins loaded. Measured,
 * not estimated: `anon-rss:849868kB`, killed by `global_oom` on a box with
 * 1870MB total. Capping V8 (`NODE_OPTIONS=--max-old-space-size=512`) does
 * **not** bound it — total-vm drops but RSS lands in the same place, so the
 * allocation is not old-space.
 *
 * **Budget ~1.5GB *free*.** An earlier revision of this note said ">=2GB",
 * which was an over-estimate made during the OOM round itself; the suite has
 * since run green to completion with roughly 1.5GB free. The symptom of not
 * having it is `Gateway disconnected: 1006` inside the stream and `agent needs
 * reconnect` from acpx, neither of which mentions memory — which is what
 * {@link openclawAcpxSpec.diagnose} is for.
 */

/**
 * Fallback loopback port for the Gateway, used only when probing for a free one
 * fails. Each instance otherwise gets its own port ({@link pickGatewayPort}): in
 * Docker every container has its own netns so a fixed port was harmless, but on
 * the host (`--local`) a second instance either failed to bind or — with
 * `--force` — silently took over the first one's gateway, config and skills
 * (TODO §P1.5).
 */
export const OPENCLAW_GATEWAY_PORT = 18789

/** Gateway port per agent home, so `diagnose` probes the port `init` chose. */
const gatewayPorts = new Map<string, number>()

/** Where {@link startGateway} redirects the daemon's stdio — per instance, not a shared /tmp path. */
const gatewayLog = (env: RuntimeEnv) => join(env.agentHome, 'gateway.log')

/**
 * Shell snippet that exits 0 iff something accepts a TCP connection on the
 * Gateway port. `openclaw health` cannot serve as this probe: it exits 0 even
 * with the gateway down, because it reports on the pipeline rather than the port.
 */
const connectProbe = (port: number) =>
  `node -e 'require("net").connect(${port},"127.0.0.1")` +
  `.on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))'`

/** Ask the env's own kernel for a free loopback port (node is present wherever openclaw is). */
async function pickGatewayPort(env: RuntimeEnv): Promise<number> {
  const { stdout, exitCode } = await env.exec([
    'node', '-e',
    'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})',
  ])
  const port = Number(stdout.trim())
  return exitCode === 0 && Number.isInteger(port) && port > 0 ? port : OPENCLAW_GATEWAY_PORT
}

/**
 * Render openclaw's `openclaw.json`. Unlike pi's `models.json` this is never
 * optional: even a provider openclaw knows natively still needs the gateway
 * stanza (so the daemon binds loopback without auth) and the model selection
 * (there being no `--model` flag to carry it).
 *
 * Schema confirmed against the pinned release's own `openclaw config schema` and
 * re-checked with `openclaw config validate` — both `gateway.auth` (an object,
 * not a string) and the `models.providers.<n>.models[].name` requirement were
 * mis-guessed first and caught that way.
 *
 * `apiKey` is deliberately a `${VAR}` *reference*, not a key: openclaw expands
 * the env var at load time, so the secret keeps arriving through `passEnv` and
 * never lands on the container's disk.
 */
export function renderOpenclawJson(config: AgentConfig, port = OPENCLAW_GATEWAY_PORT): string {
  const { model, provider } = resolveModelProvider(config)
  const apiKeyEnv = config.passEnv?.[0]

  const doc: Record<string, unknown> = {
    // A local, loopback-bound, unauthenticated daemon: it exists only to serve
    // the ACP bridge inside this one container, and never leaves it.
    gateway: { mode: 'local', auth: { mode: 'none' }, port, bind: 'loopback' },
    agents: {
      defaults: {
        ...(model ? { model: { primary: provider ? `${provider}/${model}` : model } } : {}),
        // Self-learning off by default so repeated runs stay reproducible (§7),
        // mirroring hermes' `memory_enabled`. The schema's own words: "disable
        // when you want fully stateless responses". Left on, openclaw indexes
        // MEMORY.md into the state dir and a later test can recall an earlier
        // one's work — the same cross-session leak hermes has (TODO §P0).
        memorySearch: { enabled: config.memory === true },
      },
    },
    // See §4 in the file header: this is what keeps the Gateway off npm.
    plugins: { enabled: false },
    // Bundled skills would sit alongside the skill under test and muddy both the
    // trace and the detector. Only what `loadSkill()` copies in should be live.
    skills: { allowBundled: [] },
  }

  if (config.baseUrl && provider) {
    doc.models = {
      // `merge`, not `replace`: this adds one provider without dropping the
      // built-ins the agent may still reference.
      mode: 'merge',
      providers: {
        [provider]: {
          baseUrl: config.baseUrl,
          ...(apiKeyEnv ? { apiKey: `\${${apiKeyEnv}}` } : {}),
          api: 'openai-completions',
          // `name` is required alongside `id` (minLength 1) — pi's schema lets
          // it default, openclaw's does not.
          models: model ? [{ id: model, name: model }] : [],
        },
      },
    }
  }

  return JSON.stringify(doc, null, 2)
}

/**
 * Boot the Gateway daemon and block until it accepts connections.
 *
 * `RuntimeEnv.exec` is blocking, so the daemon is launched detached with its
 * stdio fully redirected — otherwise the exec never returns. Readiness is then a
 * real TCP connect ({@link connectProbe}).
 *
 * `--allow-unconfigured` skips the interactive onboarding gate a fresh state dir
 * would otherwise hit; `--force` makes a re-boot in a reused container replace a
 * stale daemon instead of failing on the bound port.
 */
async function startGateway(env: RuntimeEnv, credentialEnv: Record<string, string>, port: number): Promise<void> {
  const log = gatewayLog(env)
  await env.exec(
    [
      'sh',
      '-c',
      `nohup openclaw gateway --allow-unconfigured --force >${log} 2>&1 </dev/null &`,
    ],
    // The Gateway, not the bridge, is what calls the model — the API key has to
    // reach *this* process.
    { env: credentialEnv },
  )

  const { exitCode, stdout, stderr } = await env.exec([
    'sh',
    '-c',
    `for i in $(seq 1 60); do if ${connectProbe(port)} 2>/dev/null; then exit 0; fi; sleep 1; done; ` +
      `echo "gateway did not listen on ${port} within 60s"; cat ${log}; exit 1`,
  ])
  if (exitCode !== 0) {
    throw new Error(`openclaw gateway failed to start\n${stdout}${stderr}`)
  }
  progress(`  openclaw gateway ready on :${port}`)
}

/**
 * The openclaw {@link AcpxSpec}: the built-in `openclaw` acpx agent, configured
 * entirely through the `openclaw.json` written into `OPENCLAW_STATE_DIR`, with
 * its Gateway daemon started as part of {@link init}. Registered as the
 * `openclaw` kind in {@link file://./registry.ts}.
 */
export const openclawAcpxSpec: AcpxSpec = {
  agent: 'openclaw',
  label: 'openclaw',
  // Deliberately no `modelFlag` — see §2 in the file header. The model comes
  // from `agents.defaults.model.primary` in the config below.
  //
  // openclaw has no skill tool: it lists installed skills in the system prompt
  // with their paths and the model `read`s the one it wants, so the firing
  // signal is that file read — the same shape as pi (§5, verified against a real
  // openclaw trace: 1 hit on a design prompt, 0 on an unrelated one).
  skillDetector: skillFileReadDetector,
  // Forced mode (TODO §P1): same prompt-level inlining as hermes and pi — the one
  // lever that reaches the model whatever the ACP bridge does. Unit-tested only:
  // the Gateway needs ~850MB, more than the dev host this was written on has.
  forceSkill: inlineSkillPrompt,
  /**
   * When acpx fails, say whether the Gateway is still alive and show its log.
   *
   * Without this a dead daemon reports only `agent needs reconnect` (or, on the
   * next turn, `ECONNREFUSED`) — which names neither openclaw's Gateway nor any
   * reason, and sends you off debugging the adapter. The single most likely
   * cause is the host OOM killer taking the daemon at ~850MB RSS, and the log's
   * abrupt end mid-request is what makes that recognisable.
   */
  async diagnose({ env }): Promise<string | undefined> {
    const port = gatewayPorts.get(env.agentHome) ?? OPENCLAW_GATEWAY_PORT
    const log = gatewayLog(env)
    const { stdout } = await env.exec([
      'sh',
      '-c',
      `if ${connectProbe(port)} 2>/dev/null; then echo "gateway: listening"; else ` +
        `echo "gateway: NOT listening on ${port} — it died during the run."; ` +
        `echo "The usual cause is the host OOM killer: the Gateway grows to ~850MB RSS,"; ` +
        `echo "and capping V8's heap does not bound it. Give the host ~1.5GB free."; fi; ` +
        `echo "--- ${log} (tail) ---"; tail -20 ${log} 2>/dev/null`,
    ])
    return stdout.trim() || undefined
  },
  async init({ env, config, credentialEnv }): Promise<void> {
    const port = await pickGatewayPort(env)
    gatewayPorts.set(env.agentHome, port)
    await env.writeFile(join(env.agentHome, 'openclaw.json'), `${renderOpenclawJson(config, port)}\n`)
    await startGateway(env, credentialEnv, port)
  },
}
