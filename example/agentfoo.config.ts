import { resolve } from 'node:path'
import { defineConfig } from 'agentfoo/config'

/**
 * Example agentfoo project: skill tests for Anthropic's `frontend-design` skill,
 * wired to run on DeepSeek.
 *
 * All provider-specific values are read from the repo-root `.env` (loaded
 * automatically by the agentfoo CLI), so you can retarget the suite without
 * editing code — copy `.env.example` to `.env` and fill it in. See that file
 * for what each variable does.
 *
 * Two independent roles both point at DeepSeek here:
 *   - `judge.model` — the grader for `toSatisfy`, called from the host via
 *     agentfoo's provider registry (`deepseek/…` prefix routes it).
 *   - `agents.<kind>.model` — the model the agent under test actually runs
 *     *inside the container*. `provider` + `baseUrl` are written into that
 *     agent's own config file (hermes' `config.yaml`, opencode's
 *     `opencode.json`); DeepSeek has no built-in endpoint for them, so
 *     `baseUrl` is set explicitly.
 *
 * Each agent is a fixed base image built from `dockers/<kind>.Dockerfile`, so
 * there's no source checkout to configure — skills are copied into the container
 * at test time, not baked in. `passEnv` forwards the API key from the host env
 * into the container at run time, so the secret never gets baked into the image
 * or config.
 *
 * **Several agents are configured, so `bootAgent()` will not guess**: pick one
 * with `npm run example -- -a hermes` / `-a opencode` / `-a pi` / `-a openclaw`.
 * (The specs themselves are agent-agnostic — skill detection is per-adapter, see
 * test/fixtures.ts.)
 *
 * Dev escape hatch: `npm run example -- --local` uses a host binary and skips
 * Docker (not CI-safe).
 */
const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'

/** The provider half of every agent here — one endpoint, one key, two agents. */
const deepseek = {
  model,
  provider: process.env.DEEPSEEK_PROVIDER || 'deepseek',
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  // API key, read from the host env at run time (never baked into the image).
  passEnv: ['DEEPSEEK_API_KEY'],
  // memory defaults to false → reproducible runs (§7).
}

export default defineConfig({
  judge: {
    model: `deepseek/${model}`,
  },
  agents: {
    hermes: {
      ...deepseek,
      // Build the pinned, self-contained agent base image (clones hermes at a
      // fixed tag — no source checkout / buildContext needed). Kept in the
      // shared dockers/ dir; resolved relative to this config so it works
      // regardless of the working directory.
      dockerfile: resolve(import.meta.dirname, '../dockers/hermes.Dockerfile'),
    },
    // The second agent (TODO PLAN §5). Its CLI *flags* are verified against the
    // real 1.18.5 binary, but the trace envelope, session-id key, provider-config
    // schema and skills directory are not — expect the first runs here to be the
    // thing that pins them (scripts/probe-opencode.sh answers all four at once).
    opencode: {
      ...deepseek,
      dockerfile: resolve(import.meta.dirname, '../dockers/opencode.Dockerfile'),
    },
    // The third agent. Driven through acpx like hermes, but configured through
    // its own `models.json` (written into PI_CODING_AGENT_DIR) because acpx has
    // no `--base-url` to reach a custom endpoint with.
    pi: {
      ...deepseek,
      dockerfile: resolve(import.meta.dirname, '../dockers/pi.Dockerfile'),
    },
    // The fourth agent. Also acpx-driven, but `openclaw acp` is only a bridge to
    // a Gateway daemon the adapter starts during init — that daemon wants ~600MB
    // RSS, so give this one more headroom than the others.
    openclaw: {
      ...deepseek,
      dockerfile: resolve(import.meta.dirname, '../dockers/openclaw.Dockerfile'),
    },
  },
  // A single hermes container per spec file (see test/fixtures.ts, §4).
  setupFiles: ['./test/fixtures.ts'],
})
