import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildTrace } from '../src/trace.js'
import type { Trace } from '../src/types.js'

/**
 * Helpers for the recorded stdout captures under `test/fixtures/`.
 *
 * Two of those captures are OpenAI-shaped *message records* (one JSON object per
 * line). No shipped decoder reads that file format any more —
 * `parseOpenAiChatTrace` was removed (TODO §P3) because no agent produced it and
 * it had never been checked against a real CLI — but the record shape itself is
 * still agentfoo's internal IR: both stream parsers reduce to it, and
 * {@link buildTrace} normalizes it. So these captures remain the cheapest way to
 * build a *realistic* trace for matcher and detector tests, and reading them
 * simply goes through `buildTrace` directly instead of a decoder that only
 * existed to split lines and tolerate banner noise.
 */

/** Read one recorded capture verbatim. */
export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
}

/** Normalize a capture of OpenAI-record-shaped jsonl into a {@link Trace}. */
export function fixtureTrace(name: string): Trace {
  const records = fixture(name)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
  return buildTrace(records)
}
