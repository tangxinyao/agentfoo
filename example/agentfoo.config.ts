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
 *   - `agents.hermes.model` — the model hermes actually runs *inside the
 *     container* (the agent under test). `provider` + `baseUrl` are written into
 *     hermes' config.yaml; DeepSeek has no built-in endpoint so `baseUrl` is set.
 *
 * The agent is a fixed base image: `hermes.Dockerfile` clones hermes at a pinned
 * tag, so there's no source checkout to configure — skills are copied into the
 * container at test time, not baked in. `passEnv` forwards the API key from the
 * host env into the container at run time, so the secret never gets baked into
 * the image or config.
 *
 * Dev escape hatch: `npm run example -- --local` uses a host hermes binary and
 * skips Docker (not CI-safe).
 */
const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'

export default defineConfig({
  judge: {
    model: `deepseek/${model}`,
  },
  agents: {
    hermes: {
      model,
      provider: process.env.DEEPSEEK_PROVIDER || 'deepseek',
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      // Build the pinned, self-contained agent base image (clones hermes at a
      // fixed tag — no source checkout / buildContext needed). Kept in the
      // shared dockers/ dir; resolved relative to this config so it works
      // regardless of the working directory.
      dockerfile: resolve(import.meta.dirname, '../dockers/hermes.Dockerfile'),
      // API key, read from the host env at run time (never baked into the image).
      passEnv: ['DEEPSEEK_API_KEY'],
      // memory defaults to false → reproducible runs (§7).
    },
  },
  // A single hermes container per spec file (see test/fixtures.ts, §4).
  setupFiles: ['./test/fixtures.ts'],
})
