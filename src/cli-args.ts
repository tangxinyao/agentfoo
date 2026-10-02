/**
 * Argv helpers for the agentfoo CLI, split out of `cli.ts` so they are testable —
 * `cli.ts` is a bin entry that calls `main()` on import, so importing it from a
 * test would spawn vitest.
 */

/**
 * Split an agentfoo-only `--name <value>` / `--name=<value>` option out of the
 * argv, returning the value and the remaining args to forward to vitest. These
 * options must be *consumed*: vitest doesn't know them and would reject them.
 *
 * Any of `names` matches (e.g. `['-a', '--agent']`), and the last occurrence wins,
 * matching the usual "later flag overrides earlier" shell convention. A trailing
 * flag with no value yields `''` rather than swallowing the next argument, so the
 * caller can tell "flag absent" (`undefined`) from "flag given without a value"
 * (`''`) and print a usage error instead of silently eating a path filter.
 */
export function takeOption(args: string[], names: string[]): { value?: string; args: string[] } {
  const out: string[] = []
  let value: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const eqName = names.find((n) => a.startsWith(`${n}=`))
    if (names.includes(a)) {
      value = args[++i] ?? ''
    } else if (eqName) {
      value = a.slice(eqName.length + 1)
    } else {
      out.push(a)
    }
  }
  return { value, args: out }
}
