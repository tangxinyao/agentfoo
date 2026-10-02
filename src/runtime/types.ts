export interface ExecOptions {
  /** Extra env vars merged over the runtime's base env. */
  env?: Record<string, string>
  /** Working directory inside the environment. Defaults to the workspace. */
  cwd?: string
  /**
   * Kill the command after this many ms and resolve with `timedOut: true`. The
   * kill happens where the process lives — the local process group, or inside
   * the container — since killing only a `docker exec` client leaves the
   * command running.
   */
  timeoutMs?: number
  /**
   * Called for every stdout chunk as it arrives, with the ms elapsed since the
   * command started. Feeds {@link file://../steps.ts StepRecorder}: without it a
   * long turn's stream carries no timing at all, so "the model was slow" and "a
   * tool ran for minutes" cannot be told apart after the fact. Never called for
   * stderr — the trace envelopes all arrive on stdout, and a diagnostic line on
   * stderr must not shift the timeline.
   */
  onStdoutChunk?: (chunk: string, atMs: number) => void
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  /** Set when {@link ExecOptions.timeoutMs} fired. */
  timedOut?: boolean
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
  /**
   * Env var this runtime sets to `agentHome` on every exec by default (hermes:
   * `HERMES_HOME`). Exposed so an adapter can override it per call — e.g.
   * {@link file://../agent/acpx.ts AcpxAgent}'s `isolatePerTest` points a
   * freshly spawned process at a different, per-test home (TODO §P0).
   */
  readonly homeEnvVar: string
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>
  /** Copy a host directory's contents into `dest` inside the env. */
  copyDir(hostSrc: string, dest: string): Promise<void>
  readFile(path: string): Promise<string>
  /**
   * Write `content` to `path` inside the env, creating parent dirs. The one way
   * adapters put config files into place: the old per-adapter `cat <<'EOF'`
   * heredocs broke on any content containing the delimiter and were
   * shell-quoting sensitive for YAML and `${VAR}` references (TODO §P3).
   */
  writeFile(path: string, content: string): Promise<void>
  teardown(): Promise<void>
}

/** Per-agent home layout the runtime needs to expose the CLI's config/session dir. */
export interface AgentHome {
  /**
   * Env var the runtime sets to the agent's home dir on every exec, so each CLI
   * finds its isolated config/session store (hermes: `HERMES_HOME`; opencode:
   * `XDG_CONFIG_HOME`). Supplied by the agent registry.
   */
  homeEnvVar: string
}

export interface Runtime {
  readonly kind: 'local' | 'docker'
  boot(id: string, home: AgentHome): Promise<RuntimeEnv>
}
