# agentfoo

A **vitest-like unit test framework for agent skills**. You write tests in the
vitest DSL you already know; agentfoo adds the pieces that make testing an agent
practical: booting the agent in a container, detecting when a skill was actually
pulled in, and grading free-form output with an LLM judge.

> **Scope (v0.1):** agentfoo currently targets **hermes-agent** as the agent
> under test. The core (trace parsing, skill-invocation spies, the LLM judge,
> retries) is agent-agnostic, but the only shipped adapter is `HermesAgent`.
> Treat the API as pre-1.0 and subject to change.

## What you get

- **Native vitest DSL** — `test` / `expect` / `describe` / fixtures, re-exported
  from `agentfoo`. Importing the package registers the custom matchers as a side
  effect.
- **Real agent runs in Docker** — each spec file boots a hermes container
  (`bootAgent('hermes')`), runs real model turns, and tears down. A `--local`
  escape hatch runs against a host binary for fast dev iteration.
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
import type { HermesAgent, SkillHandle } from 'agentfoo'

interface Fixtures { hermes: HermesAgent; frontendDesign: SkillHandle }

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

## Running

```sh
agentfoo run                      # run all specs (Docker runtime)
agentfoo run skills/frontend      # path filter
agentfoo run -t "should trigger"  # name filter (passed through to vitest)
agentfoo run --local              # use a host hermes binary, skip Docker
agentfoo watch                    # watch mode
```

The CLI loads the nearest `.env` (provider keys / model wiring), auto-discovers
`agentfoo.config.ts`, and forwards everything else to vitest.

## Configuration

`defineConfig` accepts vitest's `UserConfig` plus:

| Field | Meaning |
|---|---|
| `judge.model` | Model used by `toSatisfy` to grade output (`provider/model`) |
| `agents.<name>` | Per-agent config: `model`, `provider`, `baseUrl`, `dockerfile`/`image`, `passEnv`, `memory` |
| `retries` | Default attempt count consumed by `retry()` (not wired into vitest's global retry) |

## License

MIT © tangxinyao
