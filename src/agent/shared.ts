import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { preview } from '../progress.js'

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

/**
 * Swap a skill's host dir for a candidate registered under the same skill name
 * in `AGENTFOO_SKILL_OVERRIDES` (a JSON `{ "<name>": "<dir>" }`). This is how
 * `agentfoo optimize` evaluates a candidate SKILL.md with the user's unchanged
 * specs and fixtures, without ever writing to the skill being optimized.
 */
export async function resolveSkillOverride(hostPath: string): Promise<string> {
  const raw = process.env.AGENTFOO_SKILL_OVERRIDES
  if (!raw) return hostPath
  let map: Record<string, string>
  try {
    map = JSON.parse(raw) as Record<string, string>
  } catch {
    throw new Error(`AGENTFOO_SKILL_OVERRIDES is not valid JSON: ${raw.slice(0, 200)}`)
  }
  return map[await readSkillName(hostPath)] ?? hostPath
}

/**
 * The forced-mode lever shared by every ACP agent that has one (TODO §P1):
 * inline the SKILL.md body ahead of the user's prompt. Prompt-level rather than
 * system-prompt-level placement, but the one lever guaranteed to reach the model
 * whatever the ACP bridge does with `_meta` fields.
 *
 * `skillDir` is where the skill was copied inside the runtime. Inlined on its
 * own, the body loses its location, so any `references/…` or `scripts/…` path it
 * mentions is unresolvable — stating the directory keeps progressive disclosure
 * working the same as when the agent discovers the skill itself.
 */
export function inlineSkillPrompt(ctx: { skillBody: string; skillDir: string; prompt: string }): string {
  return (
    `The following skill is active for this task — follow its instructions. ` +
    `Relative paths it mentions are inside ${ctx.skillDir}.\n\n` +
    `${ctx.skillBody}\n\n---\n\n${ctx.prompt}`
  )
}

/** The error a per-turn timeout (`run(prompt, { timeout })`) rejects with. */
export function turnTimedOut(label: string, prompt: string, ms: number, output: string): Error {
  const tail = output.trim().split('\n').slice(-10).join('\n')
  return new Error(
    `${label} turn exceeded its ${Math.round(ms / 1000)}s timeout and was killed: "${preview(prompt)}"` +
      (tail ? `\n\nlast output:\n${tail}` : ''),
  )
}
