import { relative } from 'node:path'
import { runDir, writeRunReport } from './artifacts.js'

/**
 * Artifact reporter (§9). Runs alongside vitest's default reporter; its only
 * jobs are to write the run summary (`report.json`) and to print the artifacts
 * directory at the end so the path is one click away when debugging.
 */

interface TaskLike {
  type?: string
  mode?: string
  result?: { state?: string; duration?: number }
  tasks?: TaskLike[]
}

interface Totals {
  passed: number
  failed: number
  skipped: number
  duration: number
}

function tally(tasks: TaskLike[], totals: Totals): void {
  for (const task of tasks) {
    if (task.tasks?.length) {
      tally(task.tasks, totals)
      continue
    }
    const state = task.result?.state
    if (state === 'pass') totals.passed++
    else if (state === 'fail') totals.failed++
    else totals.skipped++
    totals.duration += task.result?.duration ?? 0
  }
}

class AgentfooReporter {
  onFinished(files: TaskLike[] = []): void {
    const totals: Totals = { passed: 0, failed: 0, skipped: 0, duration: 0 }
    tally(files, totals)

    writeRunReport({
      runId: process.env.AGENTFOO_RUN_ID ?? 'local',
      ...totals,
      runtime: process.env.AGENTFOO_FORCE_LOCAL ? 'local' : undefined,
      finishedAt: new Date().toISOString(),
    })

    const dir = relative(process.cwd(), runDir())
    // eslint-disable-next-line no-console
    console.log(`\n       Logs  ${dir}/`)
    if (process.env.AGENTFOO_FORCE_LOCAL) {
      // eslint-disable-next-line no-console
      console.log(
        '     ⚠︎ ran in LOCAL runtime — results do NOT represent the CI/Docker environment (§3).',
      )
    }
  }
}

/** Reporter instance referenced from defineConfig's `reporters` array. */
export const AGENTFOO_REPORTER = new AgentfooReporter()
