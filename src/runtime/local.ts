import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecOptions, ExecResult, Runtime, RuntimeEnv } from './types.js'

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

  async boot(id: string): Promise<RuntimeEnv> {
    const root = await mkdtemp(join(tmpdir(), `agentfoo-${id}-`))
    const workspacePath = join(root, 'workspace')
    const agentHome = join(root, 'hermes-home')
    const skillsPath = join(agentHome, 'skills')
    await mkdir(workspacePath, { recursive: true })
    await mkdir(skillsPath, { recursive: true })
    return new LocalEnv(id, root, workspacePath, skillsPath, agentHome)
  }
}

class LocalEnv implements RuntimeEnv {
  constructor(
    readonly id: string,
    private readonly root: string,
    readonly workspacePath: string,
    readonly skillsPath: string,
    readonly agentHome: string,
  ) {}

  exec(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const [cmd, ...args] = argv
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd ?? this.workspacePath,
        env: {
          ...process.env,
          HERMES_HOME: this.agentHome,
          ...opts.env,
        },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d.toString()))
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('error', reject)
      child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }))
    })
  }

  async copyDir(hostSrc: string, dest: string): Promise<void> {
    await mkdir(dest, { recursive: true })
    await cp(hostSrc, dest, { recursive: true })
  }

  readFile(path: string): Promise<string> {
    return readFile(path, 'utf8')
  }

  async teardown(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
  }
}
