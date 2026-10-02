import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentHome, ExecOptions, ExecResult, Runtime, RuntimeEnv } from './types.js'

/**
 * Host env vars a spawned CLI needs to find its own binaries/cache (PATH, HOME)
 * and behave sanely in a terminal-less context (LANG/LC_ALL, TERM), plus
 * TMPDIR for anything that shells out to its own temp files. Deliberately NOT
 * the full `process.env` (TODO §P1.5 #4): docker's env is already this minimal
 * (only `homeEnvVar` + `opts.env`), and spreading the whole host env here meant
 * a developer's real `PI_CODING_AGENT_DIR`, `OPENCLAW_STATE_DIR`, or unrelated
 * provider API keys would leak into a child that never asked for them via
 * `passEnv` — the "isolation" promise only actually held for `homeEnvVar`.
 */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR']

function baseEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key]
    if (v !== undefined) out[key] = v
  }
  return out
}

/**
 * Local runtime (§3): runs the installed agent binary directly on the host in a
 * throwaway temp directory. This is the fast dev-loop escape hatch — NOT
 * CI-safe, because a buggy skill's real shell/file operations are not
 * sandboxed. Reporters must flag local runs loudly.
 *
 * Isolation we *do* provide: a fresh workspace dir per instance and a dedicated
 * agent home (HERMES_HOME) so runs never touch the developer's real
 * ~/.hermes config, skills, or session store.
 */
export class LocalRuntime implements Runtime {
  readonly kind = 'local' as const

  async boot(id: string, home: AgentHome): Promise<RuntimeEnv> {
    const root = await mkdtemp(join(tmpdir(), `agentfoo-${id}-`))
    const workspacePath = join(root, 'workspace')
    const agentHome = join(root, 'agent-home')
    const skillsPath = join(agentHome, 'skills')
    await mkdir(workspacePath, { recursive: true })
    await mkdir(skillsPath, { recursive: true })
    return new LocalEnv(id, root, workspacePath, skillsPath, agentHome, home.homeEnvVar)
  }
}

class LocalEnv implements RuntimeEnv {
  /**
   * Every pid this env has ever spawned, kept for the env's whole lifetime
   * (not removed on close — see {@link teardown}).
   */
  private readonly pids = new Set<number>()

  constructor(
    readonly id: string,
    private readonly root: string,
    readonly workspacePath: string,
    readonly skillsPath: string,
    readonly agentHome: string,
    readonly homeEnvVar: string,
  ) {}

  exec(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const [cmd, ...args] = argv
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd ?? this.workspacePath,
        // New process group (§teardown) so a background process the CLI
        // spawns and detaches — e.g. acpx's queue-owner daemon (TODO §P1.5 #4)
        // — inherits it too, unless that process escapes with its own setsid.
        detached: true,
        // stdin at /dev/null, never an open pipe. A CLI that accepts a piped
        // prompt drains stdin before it starts work, and Node's default
        // `stdio: 'pipe'` hands it a pipe nobody ever closes — `opencode run`
        // then blocks forever on an EOF that never comes, with the turn's
        // stdout still empty. DockerEnv gets this for free (`docker exec`
        // without `-i` already closes it), which is why the hang was
        // `--local`-only. Nothing here writes to a child's stdin.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...baseEnv(),
          [this.homeEnvVar]: this.agentHome,
          ...opts.env,
        },
      })
      if (child.pid) this.pids.add(child.pid)
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true
            try {
              process.kill(-(child.pid as number), 'SIGKILL') // the whole group, not just the leader
            } catch {
              // already gone
            }
          }, opts.timeoutMs)
        : undefined
      child.stdout.on('data', (d) => (stdout += d.toString()))
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ stdout, stderr, exitCode: code ?? -1, ...(timedOut ? { timedOut } : {}) })
      })
    })
  }

  async copyDir(hostSrc: string, dest: string): Promise<void> {
    await mkdir(dest, { recursive: true })
    await cp(hostSrc, dest, { recursive: true })
  }

  readFile(path: string): Promise<string> {
    return readFile(path, 'utf8')
  }

  async writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }

  /**
   * Kill every process group this env ever spawned before deleting its temp
   * dir — `rm -rf` alone leaves anything backgrounded (TODO §P1.5 #4) running
   * against a now-deleted cwd. Each pid was its own group leader (`detached`
   * in {@link exec}), so `-pid` reaches any child it left behind too, as long
   * as that child didn't further detach into its own session. Best-effort:
   * the group's leader has usually already exited by teardown time (ESRCH is
   * expected, not an error), and a runtime teardown must never throw over a
   * process that's already gone.
   */
  async teardown(): Promise<void> {
    for (const pid of this.pids) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        // Already exited, or never became a reachable group — nothing to do.
      }
    }
    await rm(this.root, { recursive: true, force: true })
  }
}
