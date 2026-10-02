# agentfoo

A **vitest-like unit test framework for agent skills**. You write tests in the
vitest DSL you already know; agentfoo adds the pieces that make testing an agent
practical: booting the agent in a container, detecting when a skill was actually
pulled in, and grading free-form output with an LLM judge.

> **Scope (v0.1):** agentfoo tests multiple coding agents — **hermes**, **pi**,
> and **openclaw** through the [acpx](https://github.com/openclaw/acpx) ACP
> client, plus **opencode** natively — and routes the judge / agent inference
> through several providers (anthropic, deepseek, GLM, MiniMax, Kimi). The
> `hermes` (0.18.2 / acpx 0.12.1), `opencode` (1.18.5) and `pi` (0.73.1 / pi-acp
> 0.0.32) adapters are each exercised end-to-end against a real container, as is
> the judge. `openclaw` (2026.7.1-2) is wired and probed against a real binary —
> config schema, gateway startup, trace envelope and skill detection all verified
> — and the suite runs green against it end-to-end, though its Gateway daemon
> needs ~850MB RSS, so budget ~1.5GB free on the host. Treat the API as pre-1.0
> and subject to change.

## What you get

- **Native vitest DSL** — `test` / `expect` / `describe` / fixtures, re-exported
  from `agentfoo`. Importing the package registers the custom matchers as a side
  effect.
- **Real agent runs in Docker** — each spec file boots an agent container
  (`bootAgent('hermes' | 'opencode' | 'pi' | 'openclaw')`), runs real model
  turns, and tears down. A `--local` escape hatch runs against a host binary for
  fast dev iteration.
- **Skill-invocation spies** — a `SkillHandle` is both "load this skill" and the
  spy target: `expect(skill).toHaveBeenCalled()`.
- **LLM-judge assertions** — `await expect(trace).toSatisfy(rubric, { threshold })`
  grades open-ended output against a weighted rubric.
- **Opt-in retries** — `retry(fn, { attempts, policy })` for flaky live runs,
  explicitly per-block (never silently applied to every slow test).
- **Artifacts on disk** — every run writes traces and session dumps under
  `.agentfoo/runs/<id>/` for debugging.

## Requirements

- **Node.js ≥ 18.19**
- **Docker** (for the default containerized runtime; not needed for `--local`)
- An **LLM API key** for live runs (judge model + the agent's own model)

## Install

```sh
npm install --save-dev agentfoo vitest
```

## Quick start

**1. `agentfoo.config.ts`** — a thin wrapper over vitest config:

```ts
import { resolve } from 'node:path'
import { defineConfig } from 'agentfoo/config'

export default defineConfig({
  judge: { model: 'deepseek/deepseek-v4-pro' },
  agents: {
    hermes: {
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      dockerfile: resolve(import.meta.dirname, './dockers/hermes.Dockerfile'),
      passEnv: ['DEEPSEEK_API_KEY'], // forwarded into the container at run time
    },
  },
  setupFiles: ['./test/fixtures.ts'],
})
```

**2. Shared fixtures** (`test/fixtures.ts`) — one container per spec file:

```ts
import { fileURLToPath } from 'node:url'
import { test as base, bootAgent } from 'agentfoo'
import type { Agent, SkillHandle } from 'agentfoo'

interface Fixtures { hermes: Agent; frontendDesign: SkillHandle }

export const test = base.extend<Fixtures>({
  hermes: [
    async ({}, use) => {
      const agent = await bootAgent('hermes')
      await use(agent)
      await agent.teardown()
    },
    { scope: 'file' },
  ],
  frontendDesign: async ({ hermes }, use) => {
    await use(await hermes.loadSkill(
      fileURLToPath(new URL('../skills/frontend-design', import.meta.url)),
    ))
  },
})

export { expect } from 'agentfoo'
```

**3. A spec** (`skills/frontend-design/frontend-design.spec.ts`):

```ts
import { test, expect } from '../../test/fixtures'

test('triggers on a UI design request', async ({ hermes, frontendDesign }) => {
  const trace = await hermes.run('Design a landing page for a coffee brand.')

  expect(frontendDesign).toHaveBeenCalled()

  await expect(trace).toSatisfy(
    [
      { criteria: 'Makes deliberate typography/color/layout choices', weight: 2 },
      { criteria: 'Choices relate to the coffee-brand theme', weight: 2 },
      { criteria: 'Mentions accessibility or responsiveness', weight: 1 },
    ],
    { threshold: 0.7 },
  )
})
```

### What the judge sees, and what gets recorded

`toSatisfy` on a trace grades **`trace.finalMessage`** by default. Pass
`{ target: 'transcript' }` to grade the whole conversation instead (tool calls and
their results included) — only do that when the rubric is about the *process*.
The transcript also contains every file the agent read, and for agents that load a
skill by reading its `SKILL.md` (pi, openclaw) that means the skill's own
instructions get graded as if they were the answer: measured on pi, the same weak
answer passed 3/3 gradings as a transcript and 1/3 as a final message.

Every grading, pass or fail, is written to
`.agentfoo/runs/<id>/<test>/judge-<n>.json` (model, target, threshold, score and
the per-criterion verdicts with the judge's reasons), and `report.json` lists each
test with its state, duration, and the score plus unmet criteria of every grading
— so a 0.71 scrape-by is distinguishable from a 1.00 without rerunning.

## Running

```sh
agentfoo run                      # run all specs (Docker runtime)
agentfoo run skills/frontend      # path filter
agentfoo run -t "should trigger"  # name filter (passed through to vitest)
agentfoo run -a opencode          # run the same specs against another agent
agentfoo run -a pi                # …or a third
agentfoo run --local              # use a host agent binary, skip Docker
agentfoo list                     # collect specs only — zero-cost wiring check
agentfoo run --env-file ../.env   # load an explicit .env (e.g. a sibling repo's)
agentfoo watch                    # watch mode
```

The CLI loads the nearest `.env` (provider keys / model wiring), auto-discovers
`agentfoo.config.ts`, and forwards everything else to vitest. `agentfoo list`
collects and prints the matched specs **without booting a container or calling a
model** — the cheapest way to confirm config, fixtures, and specs all resolve.
Use `--env-file <path>` when your suite lives in a subtree that can't reach the
`.env` by walking up from the cwd.

### Choosing the agent

`-a <kind>` (`--agent`) picks which agent from `agents` the suite runs against, so
one set of specs can be pointed at several agents. Fixtures opt in by calling
`bootAgent()` **with no kind**:

```ts
agent: [
  async ({}, use) => {
    const agent = await bootAgent()   // ← -a decides; no kind hard-coded
    await use(agent)
    await agent.teardown()
  },
  { scope: 'file' },
],
```

With no `-a`, `bootAgent()` uses the sole configured agent. If several are
configured and none is selected it throws rather than guessing — running a suite
against the wrong agent shows up as a skill that "stopped firing", which is an
expensive thing to debug. Passing a kind explicitly (`bootAgent('hermes')`) pins
the fixture and ignores `-a`, which is right for a spec that is genuinely about
one agent's behaviour.

> Note: skill-invocation detection is still per-worker global
> (`setSkillDetector`), and the right signal differs per agent — hermes names the
> skill only in its reasoning, opencode fires a real `skill({name})` tool call. So
> retargeting a suite with `-a` today also means revisiting the detector.

Through an npm script the flag must come after `--`, because npm consumes `-a`
itself and would forward a bare `opencode` that agentfoo then reads as a path
filter:

```sh
npm run example -- -a opencode
```

## Configuration

`defineConfig` accepts vitest's `UserConfig` plus:

| Field | Meaning |
|---|---|
| `judge.model` | Model used by `toSatisfy` to grade output (`provider/model`) |
| `judge.maxTokens` | Output-token cap for one grading call (default `32768`) |
| `judge.samples` | Grade each `toSatisfy` this many times and average (default `1`; per call: `{ samples }`) |
| `concurrency` | How many `test.concurrent` cases run at once, and the default `createAgentPool` size (default `1`) |
| `agents.<name>` | Per-agent config: `model`, `provider`, `baseUrl`, `dockerfile`/`image`, `passEnv`, `memory` |
| `retries` | Default attempt count consumed by `retry()` (not wired into vitest's global retry) |

`judge.maxTokens` caps the judge's **output**, not the transcript you feed it —
a large trace costs prompt tokens, not this budget. The default is generous
because reasoning judges (`deepseek-reasoner`, `deepseek-v4-pro`, …) bill their
hidden chain-of-thought against the same budget as the verdict JSON, and too
small a cap makes the grading call come back truncated or empty. Unused budget
isn't billed. Lower it if your judge model caps output below the default and
rejects it, or if the provider requires `prompt + max_tokens` to fit the context
window and your transcripts are very large.

`agents.<name>.model` accepts the same `provider/model` prefix as `judge.model`
(e.g. `deepseek/deepseek-v4-pro`); the prefix populates `provider` unless you set
it explicitly. If you set neither `dockerfile` nor `image`, the Docker runtime
falls back to the **Dockerfile bundled for that agent kind** (`dockers/<kind>.Dockerfile`),
so the default containerized runtime works with zero image configuration.

### Agents

`bootAgent(kind)` selects the coding agent under test. Each kind has a bundled
reference Dockerfile under `dockers/`:

| Kind | Adapter | CLI driven | Bundled image |
|---|---|---|---|
| `hermes` | `AcpxAgent` | `acpx --agent 'hermes acp'` (ACP) | `dockers/hermes.Dockerfile` |
| `opencode` | `OpencodeAgent` | `opencode run` (native) | `dockers/opencode.Dockerfile` |
| `pi` | `AcpxAgent` | `acpx pi` (ACP) | `dockers/pi.Dockerfile` |
| `openclaw` | `AcpxAgent` | `acpx openclaw` (ACP) | `dockers/openclaw.Dockerfile` |

`hermes`, `pi`, and `openclaw` share one adapter (`AcpxAgent`) that shells out to
the [acpx](https://github.com/openclaw/acpx) headless ACP client, so the same
code path reaches every ACP agent — `pi` / `openclaw` by name, `hermes` via the
`acpx --agent 'hermes acp'` escape hatch. What differs is only how each one is
*configured*, since acpx's generic `--model` has nowhere to put a `base_url`: the
adapter writes each agent's own config file into its isolated home before the
first run — `config.yaml` for hermes, `models.json` for pi, `openclaw.json` for
openclaw. The API key is forwarded via `passEnv` and never touches disk; those
files reference it by env-var name rather than embedding it.

**Per-test isolation is cwd-scoped.** acpx keys a saved session to the working
directory, so each test boundary runs `sessions new` for the instance's
workspace to start a fresh conversation — no named-session flag, which is what
lets the one adapter also drive hermes through `--agent` (where `-s` is
rejected). Multi-turn continues by reusing the same cwd session. The per-turn
`acpx --format json` output is the ACP `session/update` stream the adapter parses
into a trace.

Only `opencode` keeps a native adapter.

Note that `acpx <name>` is often not self-contained, in two different ways. For
`pi` it shells out to a separate `pi-acp` adapter package, which the bundled
Dockerfile pre-installs pinned so a test run never fetches it from npm
mid-flight. For `openclaw` it is only a *bridge*: the real agent is a
long-running **Gateway** daemon on `127.0.0.1:18789` that nothing starts
implicitly, so the adapter launches it during init and waits for the port.

> **openclaw is memory-hungry.** That Gateway reaches ~850MB RSS during a single
> turn even with plugins disabled, and capping V8's heap does not bound it. On a
> host without ~1.5GB free the OOM killer takes it mid-turn, which surfaces as
> `Gateway disconnected: 1006` / `agent needs reconnect` — mentioning neither
> memory nor the daemon. The adapter appends a gateway liveness check and log
> tail to any acpx failure so this is legible from the first failed run.

### Providers

The judge (`judge.model`) and each agent's inference (`agents.<name>.provider`)
route through a shared registry in `src/providers.ts`. Naming a known provider
auto-fills its endpoint and conventional API-key env var, so
`provider: 'glm'` (or a `glm/…` model prefix) needs no hand-written `baseUrl`:

| Provider | Prefix | Key env var(s) | Dialect |
|---|---|---|---|
| Anthropic | `anthropic/` | `ANTHROPIC_API_KEY` | Messages API |
| DeepSeek | `deepseek/` | `DEEPSEEK_API_KEY` | OpenAI-compatible |
| GLM (Zhipu / z.ai) | `glm/` | `ZHIPUAI_API_KEY` / `GLM_API_KEY` | OpenAI-compatible |
| MiniMax | `minimax/` | `MINIMAX_API_KEY` | OpenAI-compatible |
| Kimi (Moonshot) | `kimi/` | `MOONSHOT_API_KEY` / `KIMI_API_KEY` | OpenAI-compatible |

Adding a provider is one entry in `src/providers.ts`. `judge.baseUrl` /
`judge.apiKeyEnv` (or the per-agent `baseUrl` / `passEnv`) override the defaults
for a custom gateway.

### Custom skill-invocation detection

Which tool call means "a skill fired" is agent- and version-specific, so the
built-in heuristic behind `toHaveBeenCalled` is a best guess. Once you've seen
your agent's real traces, pin the signal exactly from a `setupFiles` module:

```ts
import { setSkillDetector } from 'agentfoo'

setSkillDetector((trace, skillName) =>
  trace.toolCalls.filter((c) => c.name === 'skill_view' && c.arguments.name === skillName),
)
```

When `toHaveBeenCalled` fails, the error lists the tool calls that *were*
observed, so you can tell "the skill never fired" from "it fired but the
detector didn't recognize the signal."

## Turn limits and conversations

`agent.run(prompt, { timeout: 90_000 })` bounds a single turn: the agent process
is killed where it runs (inside the container for Docker) and the call rejects
naming the turn, rather than the whole test timing out while the agent keeps
going. For a per-test limit use vitest's own `test(name, fn, { timeout })`.

Skills that ask the user something and stop — brainstorming, interviews — need a
simulated user. `converse` answers each agent turn from a list or a function
until it has nothing to add (or `maxTurns`):

```ts
import { converse } from 'agentfoo'

const c = await converse(agent, 'Help me plan a product launch', [
  'A budgeting app for students',
  'Around $5k, three months',
])
// or: converse(agent, prompt, ({ reply }) => (reply.includes('?') ? 'Yes' : undefined), { maxTurns: 5 })

await expect(c.dialogue()).toSatisfy([{ criteria: 'Asks about the audience before proposing channels' }])
```

`c.dialogue()` is the user/agent exchange of final messages only — no tool
results — so grading it can't credit a SKILL.md the agent read.

## Measuring before improving

```sh
agentfoo score --repeat 3 -a pi      # run the whole suite 3×
```

Prints the suite score as mean ± spread across runs, per-tag groups, and the
flakiest cases; details go to `.agentfoo/score/<time>/score.json`. A single run
can't tell a real change from noise — both the agent and the judge vary — and
the spread measured here is also the right `--margin` for `agentfoo optimize`
(or let it measure its own: `--margin auto`).

## Running a dataset concurrently

One agent per spec file runs a data-driven suite one case at a time. Give the
cases their own agents from a bounded pool and mark them `test.concurrent`:

```ts
// agentfoo.config.ts
export default defineConfig({ concurrency: 2, /* … */ })

// test/fixtures.ts
import { test as base, createAgentPool, testNameOf } from 'agentfoo'

export const test = base.extend<{ pool: AgentPool; agent: Agent }>({
  pool: [async ({}, use) => {
    const pool = createAgentPool()          // size defaults to `concurrency`
    await use(pool)
    await pool.teardown()
  }, { scope: 'file' }],
  agent: async ({ pool, task }, use) => {
    const agent = await pool.acquire(testNameOf(task))
    await use(agent)
    pool.release(agent)
  },
})

// a spec: use the context's `expect`, as vitest requires under concurrency
test.concurrent('case', async ({ agent, task, expect }) => {
  task.meta.split = 'train'                  // optional: grouped in report.json
  /* … */
})
```

Size `concurrency` to host memory — a pi container is ~270MB, openclaw ~850MB.
String-valued `task.meta` entries become groups in `report.json` (and a summary
printed after the run) with pass counts and the mean score of each grading
position, so a suite that grades a hard gate first and quality second gets one
column per layer.

## Improving a skill: review, suggest, optimize

A skill doesn't get better from the judge alone: rubrics are wrong in ways only
a person notices, judges are noisy, and "is this output good" is a human call.
The loop agentfoo supports is:

```sh
agentfoo run -a pi                   # 1. generate outputs + judge verdicts
agentfoo review                      # 2. a person reviews the latest run (local page)
agentfoo suggest skills/my-skill     # 3. bounded SKILL.md edits from 1 + 2
#                                      4. apply what you agree with, fix the rubric, repeat
```

- **`agentfoo review [--run <id>] [--port 4173]`** serves a page on 127.0.0.1
  where each case shows the prompt, the agent's answer and every judge verdict
  with its reason. The reviewer rates the answer 1–5, comments, marks each
  verdict *judge right / judge wrong*, and can edit, remove or add evaluation
  points. Everything saves to `.agentfoo/runs/<id>/review.json`, and the header
  tracks human–judge agreement — the number that says whether the judge can be
  trusted with less supervision. Criterion edits are recorded as "this text →
  that text"; mapping them back into your own case files is your suite's job.
- **`agentfoo suggest <skill-dir> [--run <id>] [--budget 4] [--batch 8] [--model p/m]`**
  is one backward pass in the style of SkillOpt (arXiv 2605.23904): failures and
  successes are analyzed separately in minibatches, failure edits are merged and
  ranked, rules the successes rely on are preserved, and the result is clipped to
  `budget` edits (`append` / `insert_after` / `replace` / `delete` on exact,
  unique anchors; frontmatter is off limits). A human review of the run is the
  top-priority evidence: a case rated ≤ 2 counts as a failure even if it passed,
  one rated ≥ 4 as a success even if it failed, and verdicts marked wrong are
  dropped. Output goes to `.agentfoo/suggest/<run>__<time>/` — `suggestions.md`,
  `SKILL.suggested.md`, `SKILL.md.diff` and a per-edit apply report. The skill
  itself is never modified.
- **`agentfoo compare <skill-A> <skill-B> [--judge-model p/m] [filters]`** runs the
  same suite once per version (via `AGENTFOO_SKILL_OVERRIDES`) and judges every
  case pairwise — asked in both orders, a side only wins if it wins both, so the
  judge's position bias becomes a tie instead of noise. Prints the B win rate
  with a 95% interval, plus each version's suite score and trigger precision /
  recall. **`agentfoo review --compare`** puts the same pairs in front of a person,
  blind: sides are shuffled per case and the judge's verdict only appears after
  the vote, so human preference and human–judge agreement are measured on the
  same pairs. Version and preference source are separate axes; both are recorded.
- **`agentfoo optimize-description <skill-dir> --train '<p>' --sel '<p>'`** tunes the
  frontmatter `description` for trigger accuracy. Every `toHaveBeenCalled` /
  `.not` assertion is recorded (`report.json` → `triggers`: precision, recall per
  skill); each step collects the train split's missed and spurious triggers,
  asks for a few candidate descriptions, scores each by F1 on the selection split
  and keeps the best only if it improves. Runs set `AGENTFOO_TRIGGER_ONLY=1`,
  which skips `toSatisfy`, so a description costs agent turns but no judging.
- **`agentfoo optimize <skill-dir> --train '<pattern>' --sel '<pattern>'`** runs
  the loop unattended: train split → `suggest` with a cosine-decayed budget →
  selection split with the candidate (via `AGENTFOO_SKILL_OVERRIDES`, so specs
  are unchanged) → accept only if the selection score improves by more than
  `--margin` (or, with `--margin auto`, by more than the baseline's run-to-run
  spread over `--baseline-runs` runs), feeding rejected edits back.
  `--gate pairwise` accepts on the candidate beating the current skill case by
  case instead (with `--margin auto`: the 95% interval must clear one half).
  From the second epoch on, the **slow update** reruns the train split, buckets
  cases into improved / regressed / persistently failing / stable, and writes
  durable lessons into a protected `<!-- SLOW_UPDATE_START/END -->` block that
  step edits can't touch — gated like any candidate; the optimizer also keeps
  **private notes** across epochs (`meta.md`, never shipped) that inform later
  proposals. `--no-slow-update` / `--no-meta` turn them off. Worth running only
  once the rubric has been reviewed and human–judge agreement is high; until
  then a gate built on the judge optimizes toward the judge's mistakes.

## License

MIT © tangxinyao
