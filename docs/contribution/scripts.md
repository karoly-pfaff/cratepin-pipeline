# Repository scripts

`scripts/` contains reusable repository automation. Command entry points are exposed through
`package.json`; shared modules are reached through their imports. All filenames use kebab-case.

## Command entry points

| File                        | npm command                 | Purpose                                                                              |
| --------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| `clean.mjs`                 | `npm run clean`             | Remove generated build output before compiling.                                      |
| `check-docs.mjs`            | `npm run check:docs`        | Check maintained documentation links without private/generated context.              |
| `check-plan.mjs`            | `npm run check:plan`        | Validate an optional local work plan; skip when none exists.                         |
| `check-package.mjs`         | `npm run check:package`     | Pack the build and exercise an externally installed consumer.                        |
| `prepare-package-cache.mjs` | `npm run package:cache`     | Prepare runtime registry metadata and archives before offline consumer installation. |
| `fault-sweep.mjs`           | `npm run test:fault-sweep`  | Run the transfer fault matrices over additional seeds.                               |
| `prepare-candidate.mjs`     | `npm run candidate:prepare` | Compare two packs, check two external installations and retain a private candidate.  |

`build` invokes `clean`, and `check` includes the documentation, plan and package checks.
After `npm ci --ignore-scripts`, run `npm run package:cache` with public npm access before the
first check or candidate preparation. The disposable runtime-only installation runs no lifecycle
scripts and changes no repository manifest or lock. Repeat it after clearing the npm cache or
changing runtime dependencies. CI performs this bootstrap explicitly; the later consumer
installations remain offline.
`test:fault-sweep` is an explicit extended run. Candidate preparation is also manual: run it
only after the unchanged source has passed `npm run check` and its build is available. It uses
offline dependency installation, writes candidate artifacts under `.cratepin-state/candidates/`
and does not publish a package or modify remote storage.

## Imported modules

These files implement shared operations; invoking them directly is unnecessary.

| File                        | Reached from package.json through                                | Purpose                                                                      |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `candidate-report.mjs`      | `candidate:prepare` → `prepare-candidate.mjs`                    | Repack identity, installed fingerprints and safe candidate artifacts.        |
| `documentation-recipes.mjs` | `check:package` → `package-consumer.mjs` → `package-recipes.mjs` | Parse the checked CLI/API documentation recipes.                             |
| `package-consumer.mjs`      | `check:package`, `candidate:prepare`                             | External CLI, public API, declarations, import boundaries and recipe checks. |
| `package-process.mjs`       | `check:package`, `candidate:prepare` via package modules         | Run Node/npm subprocesses with bounded execution and captured diagnostics.   |
| `package-recipes.mjs`       | `check:package`, `candidate:prepare` → `package-consumer.mjs`    | Compile and execute documentation recipes against the installed package.     |
| `package-tarball.mjs`       | `check:package`, `candidate:prepare`                             | Pack with lifecycle scripts disabled and inspect actual packed paths.        |
| `story-markdown.mjs`        | `check:plan` → `check-plan.mjs`                                  | Compare a local story's Markdown fields with its structured record.          |

## Local experiments

Machine-local experiment launchers live under ignored `.local/scripts/` and are not required
by npm commands or clean checkouts. Reusable test support stays versioned beside its tests;
the image-variant experiment uses `tests/media/variant-*.test-support.mjs`. Its manual launcher
and execution notes are local development context.
