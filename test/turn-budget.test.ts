import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineConfig } from '../src/config.js'
import {
  TURN_TIMEOUT_MARGIN_MS,
  __resetConfigCache,
  loadConfig,
  turnBudgetMs,
} from '../src/config-runtime.js'

/**
 * The per-turn budget (TODO §timeout) is what stops a runaway turn from
 * outliving the test that owns it. It has to travel from `agentfoo.config.ts`
 * (host) through the `AGENTFOO_CONFIG` payload into the worker, so both hops are
 * pinned here.
 */

describe('per-turn budget', () => {
  const original = process.env.AGENTFOO_CONFIG
  beforeEach(() => __resetConfigCache())
  afterEach(() => {
    if (original === undefined) delete process.env.AGENTFOO_CONFIG
    else process.env.AGENTFOO_CONFIG = original
    __resetConfigCache()
  })

  it('carries `timeout` into the worker payload as well as driving the vitest timeouts', () => {
    const cfg = defineConfig({ timeout: 3_000_000 })

    expect(cfg.test?.testTimeout).toBe(3_000_000)
    expect(cfg.test?.hookTimeout).toBe(3_000_000)
    const payload = JSON.parse(((cfg.test?.env ?? {}) as Record<string, string>).AGENTFOO_CONFIG) as {
      timeout?: number
    }
    expect(payload.timeout).toBe(3_000_000)
  })

  it('omits `timeout` from the payload when the suite did not set one', () => {
    const cfg = defineConfig({})
    const payload = JSON.parse(((cfg.test?.env ?? {}) as Record<string, string>).AGENTFOO_CONFIG) as {
      timeout?: number
    }
    expect(payload.timeout).toBeUndefined()
    expect(loadConfig().timeout).toBeUndefined()
  })

  it('derives the adapter bound as timeout minus the margin', () => {
    process.env.AGENTFOO_CONFIG = JSON.stringify({ timeout: 3_000_000 })
    __resetConfigCache()

    expect(turnBudgetMs()).toBe(3_000_000 - TURN_TIMEOUT_MARGIN_MS)
  })

  it('leaves adapters unbounded when the suite timeout cannot spare the margin', () => {
    process.env.AGENTFOO_CONFIG = JSON.stringify({ timeout: 30_000 })
    __resetConfigCache()

    expect(turnBudgetMs()).toBeUndefined()
    expect(loadConfig().timeout).toBe(30_000)
  })
})
