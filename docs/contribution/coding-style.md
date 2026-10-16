# Coding style

The first rule is [understandability](code-quality.md#rule-zero-understandability): names alone must tell what code does and how. The rules below serve it.

These rules are enforced by `eslint.config.js`, `.prettierrc.json` and `tsconfig.json` wherever
technically possible. Where a rule cannot be automated, it is a review requirement. Size and
complexity limits are listed in [code quality](code-quality.md).

## Naming

- **Files**: `kebab-case.ts` modules named after their single responsibility
  (`portable-path.ts`, `config/validation.ts`). Modules of one area live in a folder named
  after it (`sources/config/`); file names inside do not repeat the folder name. A unit test
  sits next to its module as `<module>.test.ts`; integration and end-to-end tests live in
  `tests/`.
- **Repository scripts**: use `kebab-case.mjs` for command entry points and their imported
  modules (`check-package.mjs`, `package-consumer.mjs`).
- **Integration tests**: files under `tests/` use kebab-case and are grouped by the behavior
  they cover (`tests/cache/concurrency.test.mjs`). Keep domain-specific support beside those
  tests; shared process fixtures and preloads live in `tests/support/`. Preserve `.test.mjs`
  and `.test-support.mjs` suffixes so discovery and tooling distinguish them.
- **Types/interfaces**: `PascalCase`, no `I` prefix (`SourceLock`, not `ISourceLock`).
- **Functions/variables**: `camelCase`; verb-first for actions (`hashFile`, `validateConfig`),
  noun-first for pure derivations (`topLevelIssues`, `localLinkTargets`).
- **Constants**: `UPPER_SNAKE_CASE` only for true module-level constants (`MAX_QUALITY`).
- **Booleans**: `is`/`has`/`was` prefixes (`isPortableRelativePath`, `hasExtraArguments`).
- **Error codes**: `UPPER_SNAKE_CASE` strings (`CONFIG_INVALID`, `NOT_IMPLEMENTED`) that stay
  stable once published.

## Functions and modules

- Group modules by responsibility. Subdivide crowded directories when the groups have clear
  names, and keep unit tests and domain-specific fixtures beside the implementation they cover.
- One function does one thing. If a body needs a comment to label a section, extract that section
  into a named helper instead.
- Prefer early returns over nested `if`/`else`; never nest ternaries.
- Express validation as data: a list of named predicates or check records filtered for failures,
  not a long chain of conditionals.
- Pass more than three values as one readonly options object.
- Modules expose a small public surface. Only `sources/index.ts` (API) and `sources/cli/main.ts` (CLI)
  are entry points; everything else is internal until deliberately exported there.

## TypeScript strictness

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals` and
  `noUnusedParameters` are enabled. Do not weaken `tsconfig.json` to make code compile.
- `any` is banned. Accept external input as `unknown` and narrow it with a type guard.
- Use `readonly` properties and `readonly T[]` for data that is not mutated, and return new values
  instead of mutating arguments.
- Use `import type` for type-only imports. Relative imports use the `.ts` extension; the build
  rewrites them.
- Use a `Map` for lookups keyed by external strings; plain objects inherit prototype keys.

## Node and I/O

- ESM only. Use `node:` specifiers for built-ins.
- Stream large files (`createReadStream`, `for await`); never read whole media files into memory
  where streaming is possible.
- Library modules never call `console` or `process.exit`; they return results or throw. The CLI
  translates results into output and `process.exitCode`.
- Errors shown to users are redacted: no credentials, signed URLs, environment dumps or raw SDK
  responses (see [R2 and credentials](../guides/r2.md)).
- Resolve paths relative to the config file, never the process working directory, unless the
  user passed the path on the command line.

## Comments

- Names explain **what**; comments explain **why**.
- No commented-out code.
- A lint suppression needs a one-line reason directly above it and must be as narrow as possible
  (one rule, one line). Unused suppressions fail the lint.
- Tool configuration exceptions carry their reason next to the exception. Do not add broad ignore
  globs to make a gate pass.

## Before finishing a change

- [ ] Is this the simplest solution for the current requirement (YAGNI)? Does an existing helper
      already do it?
- [ ] New or changed behavior has a test that would fail without the change.
- [ ] `npm run check` passes locally; the claim is based on the actual run, not an assumption.
- [ ] No lint rule was disabled without a one-line justification.
- [ ] Product docs and task-specific local context were updated when behavior or task state changed.
- [ ] Simulated, partial or blocked verification is labelled as such.
