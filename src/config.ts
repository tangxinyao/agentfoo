import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'vitest/config'
import type { AgentfooConfig } from './types.js'
import { AGENTFOO_REPORTER } from './reporter.js'

/**
 * `agentfoo.config.ts` entrypoint (§6): a thin wrapper over vitest config.
 *
 * On top of vitest it: (a) carries the agentfoo-specific config (judge model,
 * per-agent defaults, retries) into the test workers via `test.env`, (b)
 * registers the artifact reporter (§9), and (c) applies agentfoo-friendly
 * defaults for slow, external-resource tests (no watch by default, generous
 * timeouts, serial execution so containers/LLM calls don't stampede).
 */
export function defineConfig(config: AgentfooConfig = {}): UserConfig {
  const { setupFiles, include, timeout, ...rest } = config
  // `timeout` rides along into the payload as well as driving the two vitest
  // timeouts below: workers derive their per-turn budget from it (see
  // `turnBudgetMs` in fixtures.ts) so an adapter kills a runaway turn *before*
  // vitest gives up on the test that owns it.
  const agentfoo = { ...rest, ...(timeout !== undefined ? { timeout } : {}) }

  // A single agent turn is a full LLM round-trip: a big generation on a slow
  // model can run well past two minutes, so the default is generous and
  // overridable per project via `timeout` (ms). Boot (§4, docker build +
  // container start) runs in the file fixture, hence the same hookTimeout.
  const testTimeout = timeout ?? 300_000
  const concurrency = Math.max(1, Math.floor(config.concurrency ?? 1))

  // In-repo self-reference so example specs can `import from 'agentfoo'` against
  // the raw sources. Only valid when running from `src/` — a `.ts` sibling of
  // this file exists. From a compiled build (`dist/config.js`) that file is
  // absent, and injecting the alias would shadow the package's `exports` map and
  // point every `import 'agentfoo'` at a non-existent `dist/index.ts`, breaking
  // every external consumer. So gate it on the source actually being present.
  const selfIndex = fileURLToPath(new URL('./index.ts', import.meta.url))
  const selfAlias = existsSync(selfIndex) ? { agentfoo: selfIndex } : undefined

  return {
    ...(selfAlias ? { resolve: { alias: selfAlias } } : {}),
    test: {
      include: include ?? ['**/*.spec.ts'],
      setupFiles,
      testTimeout,
      hookTimeout: testTimeout,
      // Stream worker output (progress lines + docker build) to the terminal
      // live instead of buffering it until each test settles — otherwise a
      // multi-minute live run shows nothing (§ visibility). Safe here because
      // runs are serialized (fileParallelism:false, maxConcurrency:1) so lines
      // never interleave across cases.
      disableConsoleIntercept: true,
      // Slow, external-resource tests: by default run strictly one case at a time
      // so containers/LLM calls don't stampede. `fileParallelism: false` serializes
      // across spec files; `maxConcurrency: 1` + `sequence.concurrent: false`
      // serialize the `test()`s *within* a file too (even if marked `.concurrent`).
      // `concurrency: n` lifts only the second: tests explicitly marked
      // `.concurrent` then run n at a time, each on its own pooled agent
      // (createAgentPool) — n, not vitest's default 5, so no test sits in the
      // queue for an agent while its own timeout runs.
      fileParallelism: false,
      maxConcurrency: concurrency,
      sequence: { concurrent: false },
      // NB: agentfoo does *not* wire `retries` into vitest's global `test.retry`
      // — §5 requires retry to be opt-in per assertion block (via `retry()`), not
      // silently applied to every slow test. `retries` is forwarded to workers
      // below and consumed by `retry()` as its default attempt count.
      reporters: ['default', AGENTFOO_REPORTER],
      env: {
        AGENTFOO_CONFIG: JSON.stringify(agentfoo),
        // Shared across workers + reporter so all artifacts land in one dir (§9).
        AGENTFOO_RUN_ID: resolveRunId(),
        // Which agent `bootAgent()` (no explicit kind) selects, from the CLI's
        // `-a/--agent`. Forwarded explicitly rather than relying on ambient
        // inheritance so it reaches workers under every vitest pool.
        ...(process.env.AGENTFOO_AGENT ? { AGENTFOO_AGENT: process.env.AGENTFOO_AGENT } : {}),
        // Candidate-skill redirection set by `agentfoo optimize` (resolveSkillOverride).
        ...(process.env.AGENTFOO_TRIGGER_ONLY ? { AGENTFOO_TRIGGER_ONLY: process.env.AGENTFOO_TRIGGER_ONLY } : {}),
        ...(process.env.AGENTFOO_SKILL_OVERRIDES
          ? { AGENTFOO_SKILL_OVERRIDES: process.env.AGENTFOO_SKILL_OVERRIDES }
          : {}),
      },
    },
  }
}

/**
 * The run id for this invocation, pinned into the *main* process env as well as
 * the workers'.
 *
 * `test.env` only reaches the worker processes, so a run id created inline here
 * left the reporter (which runs in the main process) reading an unset
 * `AGENTFOO_RUN_ID` and falling back to `runs/local` — it then wrote report.json
 * and printed a "Logs …" path pointing at a directory containing none of the
 * traces the workers had just written under `runs/<timestamp>/`. Setting it on
 * `process.env` first makes both sides agree, and honours an id injected by CI.
 */
function resolveRunId(): string {
  process.env.AGENTFOO_RUN_ID ??= new Date()
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\..+$/, '')
  return process.env.AGENTFOO_RUN_ID
}

export type { AgentfooConfig }
