/**
 * Lets the tests import the TypeScript in `src/` directly.
 *
 * The source imports its siblings with the `.js` specifiers the compiler emits;
 * Node's type stripping does not rewrite them, so without this hook a test can
 * only reach modules that have no relative runtime imports at all.
 */

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.startsWith('.') &&
    specifier.endsWith('.js') &&
    context.parentURL?.includes('/src/')
  ) {
    return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
  }
  return nextResolve(specifier, context);
}
