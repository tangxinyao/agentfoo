/**
 * Registers {@link ./ts-resolve-hook.mjs} so the `.js`→`.ts` fallback applies to
 * config/dep resolution in this process. Wired in by the agentfoo CLI via
 * `NODE_OPTIONS=--import` when it spawns vitest; see src/cli.ts.
 */
import { register } from 'node:module'

register('./ts-resolve-hook.mjs', import.meta.url)
