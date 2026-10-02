export interface ExecOptions {
  /** Extra env vars merged over the runtime's base env. */
  env?: Record<string, string>
  /** Working directory inside the environment. Defaults to the workspace. */
  cwd?: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * A booted, isolated execution environment for one agent instance. The agent
 * adapter (§7) talks only to this interface, so swapping local↔docker (§3)
 * never touches adapter or fixture code.
 */
export interface RuntimeEnv {
  readonly id: string
  /** Path, inside the env, that runs use as their working directory. */
  readonly workspacePath: string
  /** Path, inside the env, where preloaded skills live. */
  readonly skillsPath: string
  /** Home dir for the agent's own state (hermes home: config + session db). */
  readonly agentHome: string
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>
  /** Copy a host directory's contents into `dest` inside the env. */
  copyDir(hostSrc: string, dest: string): Promise<void>
  readFile(path: string): Promise<string>
  teardown(): Promise<void>
}

export interface Runtime {
  readonly kind: 'local' | 'docker'
  boot(id: string): Promise<RuntimeEnv>
}
