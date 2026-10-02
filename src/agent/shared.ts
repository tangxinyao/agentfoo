import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * Read the named host env vars into a plain object, skipping any that are unset.
 * These are forwarded into the runtime on every agent invocation so an in-runtime
 * CLI can authenticate with its inference provider (§7) without baking secrets
 * into the image or config.
 */
export function collectCredentials(names: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names ?? []) {
    const value = process.env[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

/** Skill name from SKILL.md frontmatter, falling back to the directory name. */
export async function readSkillName(hostPath: string): Promise<string> {
  try {
    const md = await readFile(join(hostPath, 'SKILL.md'), 'utf8')
    const m = md.match(/^name:\s*(.+)$/m)
    if (m) return m[1].trim()
  } catch {
    /* fall through to dir name */
  }
  return basename(hostPath)
}

/**
 * Full SKILL.md body (frontmatter included), for forced-mode injection
 * (TODO §P1) — unlike {@link readSkillName} there is no fallback: forced mode
 * has nothing to inject if the file is missing, so a missing SKILL.md should
 * surface as a real error, not silently degrade.
 */
export function readSkillBody(hostPath: string): Promise<string> {
  return readFile(join(hostPath, 'SKILL.md'), 'utf8')
}
