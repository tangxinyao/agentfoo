import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Vitest config for agentfoo's OWN offline unit tests (`test/**\/*.test.ts`).
 *
 * These verify the framework internals — trace parsing, skill-invocation
 * detection, spy matchers, judge helpers — using recorded fixtures, so they run
 * with no Docker and no API key. The live example specs use `agentfoo.config.ts`
 * instead.
 */
export default defineConfig({
  resolve: {
    alias: {
      agentfoo: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
})
