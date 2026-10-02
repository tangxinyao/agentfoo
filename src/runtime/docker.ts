import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentHome, ExecOptions, ExecResult, Runtime, RuntimeEnv } from './types.js'
import { progress } from '../progress.js'

/**
 * Docker runtime (§3): the default, CI-safe execution path. Each agent instance
 * gets a fresh container so a buggy skill's real shell/file/git/network
 * operations are blast-radius contained.
 *
 * The image can be supplied prebuilt (`image`) or built on demand from a
 * Dockerfile (`dockerfile`) — the latter is the intended path for "bring your
 * own hermes image": agentfoo builds it once, tags it by content hash, and
 * reuses the tag until the Dockerfile changes.
 *
 * The `docker` binary is configurable via the `AGENTFOO_DOCKER` env var (split
 * on whitespace), so environments that need `sudo docker` or a drop-in like
 * `podman` work without code changes.
 */
export interface DockerRuntimeOptions {
  /** Prebuilt image tag. One of `image` / `dockerfile` is required. */
  image?: string
  /** Dockerfile to build the image from. Takes precedence over `image`. */
  dockerfile?: string
  /** Build context dir. Defaults to the Dockerfile's directory. */
  buildContext?: string
  /**
   * Basename of the bundled Dockerfile (under `dockers/`) to fall back to when
   * neither `image` nor `dockerfile` is set. Supplied per agent kind by the
   * registry. Defaults to the hermes reference image.
   */
  bundledDockerfileName?: string
  /** Container-internal workspace mount point. */
  workspacePath?: string
}

const CONTAINER_WORKSPACE = '/workspace'
const CONTAINER_HOME = '/tmp/agenthome'
const CONTAINER_SKILLS = '/tmp/agenthome/skills'

/** In-flight/finished image builds, keyed by tag, so parallel boots build once. */
const imagePromises = new Map<string, Promise<string>>()

export class DockerRuntime implements Runtime {
  readonly kind = 'docker' as const

  constructor(private readonly opts: DockerRuntimeOptions) {}

  async boot(id: string, home: AgentHome): Promise<RuntimeEnv> {
    const image = await this.resolveImage()
    const name = `agentfoo-${id}-${randomUUID().slice(0, 8)}`
    progress(`booting container ${name} (image ${image})`)
    // Long-lived container we exec into for each run; keep it alive with a
    // no-op command. `--entrypoint ""` overrides any image ENTRYPOINT (the
    // hermes image wraps argv through s6/main-wrapper) so `sleep` runs as-is.
    await runDocker([
      'run', '-d', '--name', name,
      '--entrypoint', '',
      '-w', CONTAINER_WORKSPACE,
      image,
      'sleep', 'infinity',
    ])
    await runDocker(['exec', name, 'mkdir', '-p', CONTAINER_WORKSPACE, CONTAINER_SKILLS])
    return new DockerEnv(id, name, home.homeEnvVar)
  }

  /** Ensure an image exists, building from the Dockerfile if one was given. */
  private resolveImage(): Promise<string> {
    // Precedence: explicit dockerfile → explicit image → the Dockerfile bundled
    // in the package for this agent kind. The bundle makes `runtime: 'docker'`
    // work with zero config (nothing to point `dockerfile` at) for anyone who
    // just `npm install`ed us.
    const dockerfile =
      this.opts.dockerfile ??
      (this.opts.image ? undefined : bundledDockerfile(this.opts.bundledDockerfileName))
    if (dockerfile) {
      const resolved = resolvePath(dockerfile)
      const context = this.opts.buildContext
        ? resolvePath(this.opts.buildContext)
        : dirname(resolved)
      const tag = `agentfoo-${imageTagBase(resolved)}:${hashFile(resolved)}`
      return ensureImage(tag, () => buildImage(tag, resolved, context))
    }
    if (this.opts.image) return Promise.resolve(this.opts.image)
    return Promise.reject(
      new Error('DockerRuntime requires either `image` or `dockerfile`.'),
    )
  }
}

/**
 * Absolute path to a Dockerfile bundled in the published package (`dockers/` is
 * in package.json `files`). Resolved relative to this module so it works from
 * both `src/runtime/` and the compiled `dist/runtime/`. Returns undefined if the
 * file isn't present (e.g. a partial checkout). Defaults to the hermes reference
 * image when no basename is given.
 */
export function bundledDockerfile(name = 'hermes.Dockerfile'): string | undefined {
  const p = fileURLToPath(new URL(`../../dockers/${name}`, import.meta.url))
  return existsSync(p) ? p : undefined
}

/** `hermes` / `opencode` / `acpx` from a Dockerfile path, for the image tag. */
function imageTagBase(dockerfilePath: string): string {
  return basename(dockerfilePath).replace(/\.Dockerfile$/i, '').replace(/[^a-z0-9_.-]/gi, '-') || 'agent'
}

class DockerEnv implements RuntimeEnv {
  readonly workspacePath = CONTAINER_WORKSPACE
  readonly skillsPath = CONTAINER_SKILLS
  readonly agentHome = CONTAINER_HOME

  constructor(
    readonly id: string,
    private readonly container: string,
    private readonly homeEnvVar: string,
  ) {}

  exec(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const envArgs = Object.entries({ [this.homeEnvVar]: this.agentHome, ...opts.env }).flatMap(
      ([k, v]) => ['-e', `${k}=${v}`],
    )
    return runDocker([
      'exec',
      '-w', opts.cwd ?? this.workspacePath,
      ...envArgs,
      this.container,
      ...argv,
    ])
  }

  async copyDir(hostSrc: string, dest: string): Promise<void> {
    await this.exec(['mkdir', '-p', dest])
    // `docker cp <src>/. <container>:<dest>` copies directory *contents*.
    await runDocker(['cp', `${hostSrc}/.`, `${this.container}:${dest}`])
  }

  async readFile(path: string): Promise<string> {
    const { stdout } = await this.exec(['cat', path])
    return stdout
  }

  async teardown(): Promise<void> {
    await runDocker(['rm', '-f', this.container]).catch(() => {})
  }
}

/** Build `tag` at most once per process (parallel boots await the same build). */
function ensureImage(tag: string, build: () => Promise<string>): Promise<string> {
  let p = imagePromises.get(tag)
  if (!p) {
    p = (async () => {
      if (await imageExists(tag)) return tag
      return build()
    })()
    imagePromises.set(tag, p)
  }
  return p
}

async function imageExists(tag: string): Promise<boolean> {
  const { exitCode } = await runDocker(['image', 'inspect', tag]).catch(() => ({
    exitCode: 1,
  }) as ExecResult)
  return exitCode === 0
}

async function buildImage(tag: string, dockerfile: string, context: string): Promise<string> {
  // First run only: this clones/builds hermes and can take several minutes. The
  // `docker build` output streams below (inheritStdio) so the wait is visible.
  progress(`building hermes image ${tag} (first run — this can take a few minutes)`)
  await runDocker(['build', '-f', dockerfile, '-t', tag, context], { inheritStdio: true })
  progress(`built hermes image ${tag}`)
  return tag
}

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
}

/** Resolved `[binary, ...prefixArgs]` for docker, e.g. `['sudo','docker']`. */
function dockerCommand(): string[] {
  // Treat unset *and* empty (e.g. a blank `.env` line) as "plain docker".
  const raw = process.env.AGENTFOO_DOCKER?.trim()
  return raw ? raw.split(/\s+/) : ['docker']
}

function runDocker(args: string[], opts: { inheritStdio?: boolean } = {}): Promise<ExecResult> {
  const [bin, ...prefix] = dockerCommand()
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...prefix, ...args], {
      stdio: opts.inheritStdio ? ['ignore', 'inherit', 'inherit'] : 'pipe',
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, exitCode: code })
      else reject(new Error(`docker ${args[0]} failed (exit ${code}): ${stderr || stdout}`))
    })
  })
}
