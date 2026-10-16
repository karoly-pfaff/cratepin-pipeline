# Quality strategy

| Layer          | Cases/evidence                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Config/CLI     | Versioned fields, unknown flags, zero/false, env names, cwd/config base, non-overwriting init, exit codes                    |
| Hash/catalogue | Known hash, streaming size, changed source, stable IDs, duplicate/case-colliding paths, deterministic lock                   |
| Transfer       | Fake store fault matrix, retries/auth, corruption/cancel, source changes, concurrent create, multipart abort; opt-in real R2 |
| Cache          | .part isolation, invalid hash, atomic rename, two-process access/lock recovery, prune vs active generation                   |
| Images/media   | Alpha/colour/geometry/metadata, resize/no upscale, sprite/animation, size fallback, byte-exact copied audio/print            |
| Output         | Owned markers, symlink containment, unrelated public sentinel, staged generation, every failure step, rollback/recovery      |
| Packaging      | Clean install, tarball CLI/API/declarations, no master/cache/secret data, platform scripts                                   |
| Consumer       | External CLI/API/types/recipes, changed extension mapping, Vite relative/subpath paths                                       |
| Offline/hosts  | Warm no-network/no-env build, cold failure, Windows and native WSL/Linux                                                     |

Use small synthetic deterministic fixtures rather than real copyrighted/child media. Full-file hash and decoded image semantics are acceptance authority; ETag/file existence/file-size reduction alone are not. Streaming/concurrency benchmarks use fixed explicit file sizes/workloads and measured budgets. Cross-platform deterministic encoding claims require pinned tested codec environment.

The pull/prune concurrency regression pauses the pull immediately after its claim is published,
before any network timeout starts. Both a real prune and a dry run inspect that held claim before
the test releases the pull. A deliberate eighteen-second delay models slow child startup beyond
the former pacing window; elapsed time never releases the claim. Failure cleanup kills and settles
the held child before removing its workspace.

Abandoned-claim fixtures simulate `ESRCH` for one explicitly selected external PID; they never
assume an exited child's PID stays unused. The same probe can report live/reused and must then
keep a pull or prune out. Unit workers restore their process hook; the CLI preload changes only
that PID with signal zero, delegates every other probe to the OS, and reports a probe count so
the test proves the simulation ran. Separate real live-child cases still exercise OS liveness.
This is deterministic fixture evidence, not proof that a simulated PID was absent from the OS.

Completion requires the full gate and independent review, with no known blocking corruption, path, output or credential defect. State exact tool/source-lock/encoder/consumer versions and verification limits. Developer-tool hosts are Windows and WSL/Linux; Android/macOS tool qualification is excluded. Generated-asset browser/mobile/print behavior belongs to the consuming application and is separate from tool-host checks.

## Fault matrix

`sources/push/push-fault-matrix.test.ts` and `sources/pull/pull-fault-matrix.test.ts` run every cell (one storage step and one kind of fault: a refusal transient once or until the retries are spent, a permanent refusal, an answer lost after storage acted, a connection dropped before or during the body, a flipped byte, a longer or shorter object, wrong bytes under headers that look right, another writer of the same key, a source changed while it uploads, a cancellation at each step, a corrupt cache entry, another run publishing the same entry) against the storage fake with fixed seeds 1, 2 and 3; the seed picks which request, which status and which byte. Each run checks invariants whatever the outcome. A push leaves the lock either new with every object proven or byte for byte as it was; storage holds only exact bytes (or another writer's, never replaced); no upload is left open unless the error names it, except one whose start was never answered, which only the bucket's lifecycle rule ends; and a rerun without faults commits, unless another writer's wrong bytes keep it refused. A pull leaves only cache entries that hash to their names, no part file, every corrupt entry in the quarantine, and every original available on a rerun. A failing run prints its request trace and the command that replays it: `CRATEPIN_FAULT_SEED=<n>` runs one seed, `--test-name-pattern` one cell, and `npm run test:fault-sweep` runs seeds 1 to 200. One object and one part move at a time, so a seed replays the same requests; a test proves two runs give the same trace.

Lossy profiles follow the [media quality contracts](media-semantics.md) and
[visual review procedure](visual-review.md); UI/text and exact-pixel roles need lossless semantics.
Coverage floors (90% lines and functions, 85% branches) are enforced by `npm run check`; see
[code quality](code-quality.md#test-coverage). Coverage does not replace behavior assertions.
