# Development guide

For contributors and coding agents changing Cratepin itself. To use Cratepin in another
project, follow the [product documentation](../README.md).

Use Node 24 on Windows or Linux, including WSL. Install the locked dependencies with
`npm ci --ignore-scripts`, then `npm run package:cache` while the public npm registry is reachable,
and run `npm run check`. The cache preparation installs only the declared runtime dependencies
into a disposable directory with lifecycle scripts disabled. It supplies the registry metadata
that `npm ci` alone need not cache; the external package consumer still installs offline.
Repeat preparation after runtime dependency changes or clearing the npm cache.
The complete gate includes strict types,
formatting, lint, zero duplicate blocks, dead-code detection, documentation links, tests with
coverage floors, a clean build and an external tarball consumer check. A private work-plan
check runs only when local context exists. No cloud credentials are required for this gate.

Run `npm run build` to generate JavaScript and declarations in `build/`.
`node build/cli/main.js --help` invokes the built CLI. Unit tests live beside their modules in
`sources/`; integration and end-to-end tests live in domain subdirectories of `tests/`;
shared test process support lives in `tests/support/`; repository checks are in
`scripts/`; consumer integrations are in `examples/`. Tests and development context do not ship
in the npm package.

The [source layout](source-layout.md) describes the responsibility groups under `sources/`.

Read [code quality](code-quality.md), [coding style](coding-style.md),
[testing strategy](strategy.md) and the relevant [product contracts](../README.md).
Media changes also follow the [pixel and lossy quality contracts](media-semantics.md)
and [visual review procedure](visual-review.md).
Do not weaken a gate or add a broad exception to make a change pass. Keep changes understandable
from module/function/parameter names, and update product documentation when behavior changes.

## Safety invariants

- Keep the tool independent of consuming projects and bundlers.
- Build from pinned locks, verified raw SHA-256, byte counts and project ownership.
- Preserve author originals. Never overwrite immutable keys with different bytes or commit a
  lock after partial upload verification. ETag and metadata are not raw-byte integrity proof.
- Keep logical IDs separate from output formats; never silently rewrite application content.
- Preserve alpha, geometry, sprite coordinates, animation and print-master semantics according
  to explicit profiles. Voice, effects and music are byte-preserving copies.
- Respect owned-output markers, realpath containment, bounded resources, cancellation and
  rollback-safe publication. Never delete unrelated public files or source masters.
- Offline mode resolves no credentials and makes no network calls; a cold miss is a failure.
- Credentials are environment references and are redacted from all output. Author uploads are
  explicit actions, never install/prebuild behavior. Remote deletion is unavailable.
- Cloud writes, source deletion, history rewriting and publication need a concrete authorized
  target/action. Prepare a reviewable result first.

## Completion and review

Add meaningful regression tests for changed behavior, especially hashing, transfer failures,
path safety, media semantics, concurrency, publication and external consumers. Label fakes,
partial verification and real remote/host execution accurately.

Run the full `npm run check` after the final changes. Every story requires a fresh independent
subagent review after that gate passes. The reviewer checks understandability, quality rules,
acceptance criteria, actual evidence, contracts and safety. Fix confirmed findings, rerun the
gate and obtain a fresh review. The implementer cannot mark their own changes as reviewed.

Task sequencing and commit conventions come from the current prompt or optional local context.
Do not require internal plans or decisions to build or check a clean source checkout.
