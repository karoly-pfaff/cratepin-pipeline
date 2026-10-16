# Code quality

Quality rules are executable contracts. `npm run check` is the canonical gate and fails on any
type error, formatting drift, ESLint warning, duplicated block, dead code, broken documentation
link, local-plan inconsistency when a plan is present, build failure, failing test, coverage drop
or broken package contract.

## Rule zero: understandability

Understandability is the most important quality rule and overrides every other preference. A
reader who looks at a module must know **what it does and how it works** from the names alone:
the module name, its function names, their parameters and their return types. Code that passes
every automated gate but fails this test is rejected in review.

- **The name states the whole effect.** A function name says what it produces or changes,
  including side effects: `writeStagedLock`, `downloadMissingOriginals`, `hashFile` — never
  `handleLock`, `processAssets`, `doSync`.
- **The top-level function reads as a summary of its steps.** Its body is a short sequence of
  well-named calls, each one level of detail lower (stepdown rule). Reading only those calls tells
  how the work is done.
- **No generic names.** `data`, `info`, `result`, `value`, `item`, `obj`, `tmp`, `handle`,
  `process`, `manager`, `util`, `helper` and single letters do not say what something is. Use the
  domain noun: `sourceRecord`, `fileStats`, `configIssues`.
- **One concept, one name.** Use the vocabulary of these docs consistently — original, source
  lock, derivative, generation, owned output root, read transport — and never two names for the
  same thing or one name for two things.
- **Units and kinds are in the name.** `bytes`, `sha256`, `relativePath` vs `absolutePath`,
  `timeoutMs`; booleans read as questions (`isOwnedRoot`, `hasExtraArguments`).
- **Splitting must improve naming.** When a size or complexity limit forces a split, each new
  helper needs a precise name. If no precise name exists, the split is in the wrong place.
- **Rename instead of commenting.** If a comment is needed to explain _what_ a line does, rename
  or extract until it is not. Comments are for _why_.

ESLint backs part of this (`id-length`, `id-denylist`), but naming quality is mainly a review
requirement: before finishing, read only the function signatures of the changed module and check
that they tell the story.

## Gate composition

| Command                   | Contract                                                                  |
| ------------------------- | ------------------------------------------------------------------------- |
| `npm run typecheck`       | Strict TypeScript succeeds without emitting output.                       |
| `npm run format:check`    | Every authored file follows Prettier.                                     |
| `npm run lint:code`       | ESLint correctness, type-aware TypeScript rules, SonarJS and size limits. |
| `npm run lint:duplicates` | jscpd finds no clone in `sources/` or `scripts/`.                         |
| `npm run lint:dead-code`  | Knip finds no unused file, export, dependency or configuration hint.      |
| `npm run check:docs`      | Public relative Markdown links resolve without private/generated context. |
| `npm run check:plan`      | The local work plan is consistent; skipped when it is not present.        |
| `npm run build`           | A clean `tsc` build emits JavaScript and declarations.                    |
| `npm test`                | All unit, script, integration and end-to-end tests pass.                  |
| `npm run test:coverage`   | Tests pass and coverage stays at or above the floors below.               |
| `npm run check:package`   | The packed tarball works in an external consumer (see below).             |

`npm run lint` runs the three lint gates. `npm run format` and `npm run lint:fix` apply automatic
fixes; review their diff like any other change.

Private work context is optional and is never required by a clean checkout. Local plan validation
runs when that context exists; source and package checks always run.

The setup sequence is `npm ci --ignore-scripts`, `npm run package:cache`, then `npm run check`.
The explicit cache bootstrap uses the public npm registry without lifecycle scripts. It prepares
runtime package metadata as well as archives; a lockfile-only `npm ci` need not fetch metadata
required to resolve a fresh consumer's dependency graph. The package gate's external installation
continues to use `--offline` and never bootstraps its own cache implicitly.

## Test coverage

`npm run check` runs the tests through `npm run test:coverage`, using the Node test runner's
built-in V8 coverage over every `sources/` module the tests load (test files excluded). Node
only reports loaded modules, so `sources/index.test.ts` imports the public API, which loads
every exported module; a module reachable from nowhere would be dead code for Knip. Node runs
the `.ts` files directly by stripping types, so uncovered line numbers refer to the sources.
Child processes are included, so CLI tests that spawn `sources/cli/main.ts` count. The run fails
below these global floors:

| Measure   | Floor |
| --------- | ----: |
| Lines     |   90% |
| Functions |   90% |
| Branches  |   85% |

The floors are a safety net, not a goal. Coverage proves that code ran, not that its behavior was
checked: every test asserts an observable result (return value, error, exit code, written bytes),
and a test added only to execute lines without asserting behavior is not acceptable. Branches have
a lower floor because defensive error paths (I/O failures, cancellation, platform-specific
branches) are sometimes impractical to trigger; uncovered branches in new code still need a reason
in review. Do not lower a floor to make a change pass; add the missing behavior test or remove the
unreachable code.

The streaming memory baseline keeps its 64 MiB growth budget between 32 MiB and 160 MiB
originals. Its Linux probe reads the current process image's `/proc/self/status` VmHWM because
the tested runtime's rusage peak can include its spawning fake server's pre-exec memory.
Process regressions prove parent memory is excluded and a real whole-original allocation
still exceeds the budget; other hosts use their native process resource counter.

## Test layout

- **Unit tests** sit next to the module they test: `sources/report.ts` is tested by
  `sources/report.test.ts`. They import the module directly.
- **Integration and end-to-end tests** use kebab-case filenames in domain subdirectories of
  `tests/`; shared process support lives in `tests/support/`. They exercise the tool from outside,
  for example by running the CLI as a process. `npm run check:package` is the end-to-end check
  of the packed, built tarball.
- The build (`tsconfig.build.json`) excludes `*.test.ts`, so tests never ship in the package.
  `tsconfig.json` sets `erasableSyntaxOnly`, which keeps every source runnable by Node's type
  stripping (no enums, namespaces or parameter properties).

## Structural limits

ESLint enforces these hard ceilings as errors. Warnings are not allowed (`--max-warnings=0`).

| Measure                 | Limit |
| ----------------------- | ----: |
| Lines per file          |   200 |
| Lines per function      |    40 |
| Statements per function |     8 |
| Cyclomatic complexity   |     6 |
| Cognitive complexity    |     8 |
| Nesting depth           |     2 |
| Parameters per function |     3 |
| Nested callbacks        |     2 |

Blank lines and comments do not count toward line limits. Cyclomatic complexity counts `&&`, `||`,
`??` and `?:` as well as branching statements, so long boolean chains need named predicates.

These are maximums, not design targets. Split code by responsibility rather than mechanically
extracting fragments: a helper earns its name when it states one rule, one transformation or one
side effect. Data-driven checks (a list of named predicates or `{ isValid, path, message }`
records) are preferred over long conditional chains.

Test files (`*.test.ts`, `*.test.mjs`) are exempt from file, function and statement size limits
because representative setup is verbose; TypeScript tests get the full type-aware rules. Complexity, nesting, callback depth and correctness rules still
apply to tests.

## Type-aware linting

`sources/**/*.ts` is linted with typescript-eslint `strictTypeChecked` and `stylisticTypeChecked`
through the TypeScript project service. Repository scripts, tests and this configuration are
plain JavaScript outside `tsconfig.json`, so type-aware rules are disabled for `*.js`/`*.mjs`
while all other rules still apply.

Additional rules beyond the presets:

- `@typescript-eslint/explicit-module-boundary-types`: exported functions declare return types.
- `@typescript-eslint/switch-exhaustiveness-check`: unions are handled completely.
- `@typescript-eslint/consistent-type-imports`: type-only imports use `import type`.
- `no-console`: only `sources/cli/main.ts` and `scripts/` may print; library modules return data.
- `no-param-reassign` including properties, `eqeqeq`, `prefer-const`, `no-else-return`.
- `reportUnusedDisableDirectives`: a stale `eslint-disable` comment is itself an error.

## Duplication and dead code

jscpd scans `sources/` and `scripts/` in strict mode. A clone starts at four lines and 50 tokens;
the allowed duplication threshold is zero. Tests and generated output are outside the scan.
Refactor only when duplicated code represents one shared concept.

Knip resolves the published entry points (`exports`, `bin`) from `package.json`, plus repository
scripts and tests as configured entries. Every future exception must be narrower than the reported
issue and documented next to the configuration entry.

## Package contract

`npm run check:package` treats the package like a consumer would. It packs the built package with
install scripts disabled and then requires:

- the tarball contains only `build/*.js`, `build/*.d.ts`, `package.json`, maintained documentation
  and the explicitly allowed Vite example files its guides reference; installed Markdown links
  must resolve within the package without access to the private source repository;
- an external temporary project installs the tarball offline, runs the `cratepin` bin
  (help lists implemented and planned commands; a planned command exits 3 with
  `NOT_IMPLEMENTED`; an unknown command exits 4 with `USAGE`), imports the public API,
  compiles a strict TypeScript consumer against the published declarations, and cannot
  deep-import internal build modules;
- the installed package declares no `preinstall`, `install`, `postinstall` or `prepare` script,
  so installing the tool never runs its code.

npm is run through its JavaScript entry point with node, never through a shell. Keeping
`package.json` consistent with the selected npm identity/access and free of application-specific, SDK or framework dependencies is a project rule enforced
in review, not by an automated check. The MIT identity, exact dependency pins, root lock agreement
and recorded native provenance are also candidate review requirements, following the maintainer's
decision to keep package metadata/dependency policies manual. Preserve upstream notices and
review the actual installed native dependencies before redistribution.

## Formatting

Prettier owns formatting for TypeScript, JavaScript, JSON, Markdown and YAML: single quotes,
semicolons, trailing commas, 100-column print width, two-space indentation, LF line endings.
`.editorconfig` mirrors these for editors. Generated or vendored files (`build/`, `coverage/`,
`package-lock.json`) and private `.local/` context are excluded in `.prettierignore`. Scripts
that rewrite tracked files must leave them Prettier-clean; run `npm run format` afterwards.

## Dependencies

Dev tool versions are pinned exactly in `package.json` and locked in `package-lock.json`.
`.npmrc` enables `engine-strict`, so installation fails outside the declared Node range. Install
with `npm ci --ignore-scripts` unless a dependency's install script has been reviewed. Prefer
versions that have been public for at least two weeks.

The only direct runtime dependency is Sharp, pinned exactly for image conversion. Its package has
no install script. It depends on `semver`, `@img/colour` and `detect-libc`, and lists prebuilt
binaries as optional dependencies, of which npm installs those matching the machine: one package
on Windows, the Sharp binding and a separate libvips package on Linux and macOS (WebAssembly
builds exist for other platforms). So it installs with `--ignore-scripts`.
