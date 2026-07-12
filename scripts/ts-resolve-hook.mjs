/**
 * ESM resolve hook: fall back to a sibling `.ts` when a relative `.js` specifier
 * doesn't exist.
 *
 * agentfoo ships its source as TypeScript that uses `.js` import specifiers
 * (NodeNext style). When vitest loads a project's `agentfoo.config.ts` it
 * externalizes the `agentfoo/config` package import, so Node — not Vite —
 * resolves the transitive `./reporter.js` etc. Node 24 strips types but does not
 * remap `.js`→`.ts`, so those imports fail. This hook bridges exactly that gap
 * (only when the `.ts` exists) and is a no-op against a compiled `.js` build.
 */
export async function resolve(specifier, context, next) {
  const relative = specifier.startsWith('./') || specifier.startsWith('../')
  if (relative && specifier.endsWith('.js')) {
    try {
      return await next(specifier, context)
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND') {
        try {
          return await next(specifier.slice(0, -3) + '.ts', context)
        } catch {
          throw err // no sibling .ts either — surface the original .js error
        }
      }
      throw err
    }
  }
  return next(specifier, context)
}
