import { describe, it, expect } from 'vitest'
import { LocalRuntime } from '../src/runtime/local.js'

/**
 * Coverage for TODO §P1.5: `LocalRuntime` had zero unit tests before this,
 * despite its semantics having diverged from `DockerRuntime` (exec contract)
 * and never enforcing the isolation it claims (env whitelist, process
 * cleanup). None of these need a real agent binary — they exercise the
 * runtime layer directly with plain shell commands.
 */

async function bootEnv(id: string) {
  const runtime = new LocalRuntime()
  return runtime.boot(id, { homeEnvVar: 'AGENTFOO_TEST_HOME' })
}

/** Poll until `pid` is gone (ESRCH) or the budget runs out. */
async function waitUntilDead(pid: number, budgetMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !isAlive(pid)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('LocalRuntime exec contract', () => {
  it('resolves (not rejects) on a nonzero exit from the executed command', async () => {
    const env = await bootEnv('exec-nonzero')
    try {
      const result = await env.exec(['sh', '-c', 'echo out; echo err >&2; exit 7'])
      expect(result.exitCode).toBe(7)
      expect(result.stdout).toContain('out')
      expect(result.stderr).toContain('err')
    } finally {
      await env.teardown()
    }
  })

  /**
   * The `--local` hang this guards against: `opencode run` accepts a piped
   * prompt, so it drains stdin before doing any work. Node's default
   * `stdio: 'pipe'` gives it a pipe that is never closed, and the turn blocks
   * until vitest's testTimeout kills it with an empty trace. `docker exec`
   * without `-i` closes stdin already, so only LocalRuntime was affected.
   */
  it('gives the child a closed stdin, so a reader sees EOF instead of blocking', async () => {
    const env = await bootEnv('exec-stdin')
    try {
      const result = await env.exec(['sh', '-c', 'cat; echo "[eof]"'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('[eof]')
    } finally {
      await env.teardown()
    }
  })
})

describe('LocalRuntime env allowlist (TODO §P1.5 #4)', () => {
  it('does not leak an arbitrary host env var into the child', async () => {
    process.env.AGENTFOO_TEST_LEAK_CHECK = 'should-not-leak'
    const env = await bootEnv('env-leak')
    try {
      const result = await env.exec(['sh', '-c', 'echo "[$AGENTFOO_TEST_LEAK_CHECK]"'])
      expect(result.stdout.trim()).toBe('[]')
    } finally {
      delete process.env.AGENTFOO_TEST_LEAK_CHECK
      await env.teardown()
    }
  })

  it('still sets homeEnvVar to the isolated agent home', async () => {
    const env = await bootEnv('env-home')
    try {
      const result = await env.exec(['sh', '-c', 'echo "$AGENTFOO_TEST_HOME"'])
      expect(result.stdout.trim()).toBe(env.agentHome)
    } finally {
      await env.teardown()
    }
  })

  it('still lets PATH through so the shell can find its own binaries', async () => {
    const env = await bootEnv('env-path')
    try {
      const result = await env.exec(['sh', '-c', 'echo "$PATH"'])
      expect(result.stdout.trim()).not.toBe('')
    } finally {
      await env.teardown()
    }
  })
})

describe('LocalRuntime teardown (TODO §P1.5 #2)', () => {
  it('kills a background process the exec\'d command left running', async () => {
    const env = await bootEnv('teardown-kill')
    // Mirrors the real leak this guards against: acpx's queue-owner outlives
    // the CLI invocation that spawned it. `sleep 30 &` backgrounds a child
    // that outlives the `sh -c` invocation but — absent an explicit `setsid`
    // — stays in the same process group, which `detached: true` makes the
    // group `env.exec` itself leads. Stdio is redirected to /dev/null: left
    // inherited, the backgrounded process holds the exec's stdout pipe open
    // for its whole 30s life, and Node's `close` event (what `exec` resolves
    // on) waits for every holder of that pipe to release it — not just `sh`.
    const { stdout } = await env.exec(['sh', '-c', 'sleep 30 >/dev/null 2>&1 & echo $!'])
    const pid = Number(stdout.trim())
    expect(Number.isInteger(pid)).toBe(true)
    expect(isAlive(pid)).toBe(true)

    await env.teardown()

    expect(await waitUntilDead(pid)).toBe(true)
  })

  it('does not throw when nothing is left running', async () => {
    const env = await bootEnv('teardown-clean')
    await env.exec(['sh', '-c', 'echo done'])
    await expect(env.teardown()).resolves.toBeUndefined()
  })
})

describe('LocalRuntime writeFile (TODO §P3 heredoc)', () => {
  it('writes content byte-for-byte, creating parent dirs, whatever it contains', async () => {
    const env = await bootEnv('wf')
    // Everything the old heredoc writes choked on: its own delimiter, `$VAR`s,
    // quotes, backslashes, a missing trailing newline.
    const nasty = `AGENTFOO_EOF\napiKey: "\${DEEPSEEK_API_KEY}" $HOME 'single' \\n \`tick\``
    const path = `${env.agentHome}/nested/dir/config.yaml`
    try {
      await env.writeFile(path, nasty)
      expect(await env.readFile(path)).toBe(nasty)
    } finally {
      await env.teardown()
    }
  })
})

describe('LocalRuntime exec timeout', () => {
  it('kills the whole process group and reports timedOut', async () => {
    const env = await bootEnv('to')
    try {
      const started = Date.now()
      const r = await env.exec(['sh', '-c', 'sleep 30 & sleep 30'], { timeoutMs: 300 })
      expect(r.timedOut).toBe(true)
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      await env.teardown()
    }
  })

  it('leaves a fast command alone', async () => {
    const env = await bootEnv('to2')
    try {
      const r = await env.exec(['sh', '-c', 'echo hi'], { timeoutMs: 5000 })
      expect(r).toMatchObject({ stdout: 'hi\n', exitCode: 0 })
      expect(r.timedOut).toBeUndefined()
    } finally {
      await env.teardown()
    }
  })
})
