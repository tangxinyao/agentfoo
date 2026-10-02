import { join } from 'node:path'
import type { AgentConfig } from '../types.js'
import type { RuntimeEnv } from '../runtime/types.js'
import type { AcpxSpec } from './acpx.js'
import { skillFileReadDetector } from '../skill.js'
import { resolveModelProvider } from './hermes.js'
import { progress } from '../progress.js'

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

/** Loopback port the Gateway listens on, and the bridge dials. */
export const OPENCLAW_GATEWAY_PORT = 18789

/** Where {@link startGateway} redirects the daemon's stdio, for `diagnose`. */
const GATEWAY_LOG = '/tmp/openclaw-gateway.log'

/**
 * Shell snippet that exits 0 iff something accepts a TCP connection on the
 * Gateway port. `openclaw health` cannot serve as this probe: it exits 0 even
 * with the gateway down, because it reports on the pipeline rather than the port.
 */
const connectProbe =
  `node -e 'require("net").connect(${OPENCLAW_GATEWAY_PORT},"127.0.0.1")` +
  `.on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))'`

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
export function renderOpenclawJson(config: AgentConfig): string {
  const { model, provider } = resolveModelProvider(config)
  const apiKeyEnv = config.passEnv?.[0]

  const doc: Record<string, unknown> = {
    // A local, loopback-bound, unauthenticated daemon: it exists only to serve
    // the ACP bridge inside this one container, and never leaves it.
    gateway: { mode: 'local', auth: { mode: 'none' }, port: OPENCLAW_GATEWAY_PORT, bind: 'loopback' },
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
async function startGateway(env: RuntimeEnv, credentialEnv: Record<string, string>): Promise<void> {
  await env.exec(
    [
      'sh',
      '-c',
      `nohup openclaw gateway --allow-unconfigured --force >${GATEWAY_LOG} 2>&1 </dev/null &`,
    ],
    // The Gateway, not the bridge, is what calls the model — the API key has to
    // reach *this* process.
    { env: credentialEnv },
  )

  const { exitCode, stdout, stderr } = await env.exec([
    'sh',
    '-c',
    `for i in $(seq 1 60); do if ${connectProbe} 2>/dev/null; then exit 0; fi; sleep 1; done; ` +
      `echo "gateway did not listen on ${OPENCLAW_GATEWAY_PORT} within 60s"; cat ${GATEWAY_LOG}; exit 1`,
  ])
  if (exitCode !== 0) {
    throw new Error(`openclaw gateway failed to start\n${stdout}${stderr}`)
  }
  progress(`  openclaw gateway ready on :${OPENCLAW_GATEWAY_PORT}`)
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
    const { stdout } = await env.exec([
      'sh',
      '-c',
      `if ${connectProbe} 2>/dev/null; then echo "gateway: listening"; else ` +
        `echo "gateway: NOT listening on ${OPENCLAW_GATEWAY_PORT} — it died during the run."; ` +
        `echo "The usual cause is the host OOM killer: the Gateway grows to ~850MB RSS,"; ` +
        `echo "and capping V8's heap does not bound it. Give the host ~1.5GB free."; fi; ` +
        `echo "--- ${GATEWAY_LOG} (tail) ---"; tail -20 ${GATEWAY_LOG} 2>/dev/null`,
    ])
    return stdout.trim() || undefined
  },
  async init({ env, config, credentialEnv }): Promise<void> {
    const json = renderOpenclawJson(config)
    await env.exec(['sh', '-c', `mkdir -p "${env.agentHome}"`])
    await env.exec([
      'sh',
      '-c',
      `cat > "${join(env.agentHome, 'openclaw.json')}" <<'AGENTFOO_EOF'\n${json}\nAGENTFOO_EOF`,
    ])
    await startGateway(env, credentialEnv)
  },
}
