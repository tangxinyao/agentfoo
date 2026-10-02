import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Trace } from './types.js'

/**
 * Run artifacts (§9). Every run() drops its normalized trace and the raw hermes
 * session export under `.agentfoo/runs/<run-id>/<describe>/<it>/`, because a
 * pass/fail alone is useless for debugging an LLM-driven failure.
 *
 * The run id is shared across workers and the reporter via `AGENTFOO_RUN_ID`
 * (set by defineConfig), so a single `agentfoo run` writes into one directory
 * even though vitest fans tests out across worker processes.
 */

export function currentRunId(): string {
  return process.env.AGENTFOO_RUN_ID ?? 'local'
}

export function runDir(): string {
  return join(process.cwd(), '.agentfoo', 'runs', currentRunId())
}

function sanitize(segment: string): string {
  return segment.replace(/[^\w.\- ]+/g, '_').trim() || 'unnamed'
}

/** Directory for a single test case, e.g. runs/<id>/<describe>/<it>/. */
export function testArtifactDir(testName: string): string {
  // vitest's currentTestName is "describe > it"; map " > " to nested dirs.
  const parts = testName.split(/\s*>\s*/).map(sanitize)
  return join(runDir(), ...parts)
}

export function recordTestArtifacts(
  testName: string,
  info: { trace: Trace; sessionJsonl: string; turn: number },
): void {
  const dir = join(testArtifactDir(testName), `turn-${info.turn}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'trace.json'),
    JSON.stringify(
      {
        finalMessage: info.trace.finalMessage,
        toolCalls: info.trace.toolCalls,
        messages: info.trace.messages,
      },
      null,
      2,
    ),
  )
  // The agent's own stdout, exactly as it came off the CLI — the capture every
  // envelope fix has been written against. Named neutrally because it is not
  // hermes-specific: this same file is what pinned opencode's part stream and
  // pi's ACP frames.
  writeFileSync(join(dir, 'agent-session.jsonl'), info.sessionJsonl)
}

export function writeRunReport(report: unknown): string {
  const dir = runDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'report.json')
  writeFileSync(path, JSON.stringify(report, null, 2))
  return path
}
