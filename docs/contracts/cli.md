# CLI specification

The command comes first, then its flags: `cratepin <command> [arguments] [flags]`. The whole
command line is parsed before any file, environment or network access. Every mistake — unknown
command, unknown flag, a flag the command does not support, a repeated flag, a missing or
malformed value, a wrong number of arguments — fails with `USAGE` (exit 4) and changes nothing.
`help`, `--help` or `-h` as the first word, or exactly `<known command> --help`, prints the
command list;
anywhere else they are ordinary (invalid) tokens. `--` ends the options: every later token is
an argument, so `hash -- -file.png` works.

## Flags

| Flag                 | Meaning                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--config <file>`    | Config file, default `cratepin.config.json` in the working directory. Paths inside it resolve from its own directory.                        |
| `--json`             | Print the report as JSON instead of text; both carry the same facts.                                                                         |
| `--dry-run`          | Report what would happen; write nothing locally or remotely.                                                                                 |
| `--offline`          | Never resolve credentials or contact storage (no request, no DNS); for `pull` and `build` a cold cache fails with every missing ID and hash. |
| `--concurrency <n>`  | Override `limits.concurrency` for this run, 1–64.                                                                                            |
| `--confirm-removals` | `push` only: accept that the new lock no longer lists some IDs; their stored originals stay.                                                 |
| `--restore-sources`  | `pull` only: also write locked source files missing from `sourceDir`; an existing file is never replaced.                                    |

Values may be given as `--flag value` or `--flag=value` and may not be empty; a separate value
may not start with `-`. Subcommands are fixed words (`cache prune`, `remote gc`), not free
arguments. A command only accepts the flags that change its behavior; passing any other flag is a usage error rather than a silently ignored
policy.

## Implemented now

| Command       | Accepted flags                                                                       | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`        | `--config`, `--dry-run`, `--json`                                                    | Writes a complete default config (without `outputUrlPath`, which follows `outputDir`); refuses to overwrite (`OUTPUT_CONFLICT`, exit 9); `--dry-run` writes nothing and reports the same conflict or missing directory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `validate`    | `--config`, `--json`                                                                 | Validates the config ([schema](config.md)) and the real directory layout it describes, and reports resolved absolute paths; writes nothing, no environment or network access.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `hash`        | `--json`                                                                             | `hash <file>` streams SHA-256 and counts bytes of one local file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `scan`        | `--config`, `--json`                                                                 | Lists, identifies and hashes the originals the config selects ([inventory](data.md#source-inventory), [catalog](data.md#source-catalog)) and previews how the committed lock would change ([diff](data.md#lock-diff-and-upload-plan)); reads only, writes nothing, no environment or network access.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `push`        | `--config`, `--json`, `--dry-run`, `--concurrency`, `--confirm-removals`             | Uploads new originals create-only, verifies every referenced object by readback, then replaces the lock file in one step ([push](../guides/r2.md#push)); needs writer credentials. `--dry-run` prints the lock changes and the upload plan instead ([data](data.md#lock-diff-and-upload-plan)) and touches nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pull`        | `--config`, `--json`, `--dry-run`, `--concurrency`, `--offline`, `--restore-sources` | Makes every original the committed lock pins available as a verified cache entry, downloading misses by exact key through the configured read transport ([pull](data.md#verified-cache-and-pull)); `--offline` never downloads, `--restore-sources` also writes missing source files, `--dry-run` only reports and touches nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `build`       | `--config`, `--json`, `--dry-run`, `--concurrency`, `--offline`                      | Publishes the committed lock's outputs into the owned output root ([build](data.md#build)): gets every original like `pull` (`--offline` never downloads), converts or reuses each output and publishes the complete output, by a recoverable directory swap in path-preserving mode ([publication](../guides/safety.md#path-preserving-publication)) or a new generation and a one-step manifest switch in generation mode ([generations](../guides/safety.md#generation-publication)); an identical published output is left untouched. `--dry-run` reports what a build would read, convert and publish ([manifest](data.md#generated-runtime-manifest)) and what would change, writing nothing, taking no claim, resolving no credential and contacting no storage. |
| `verify`      | `--config`, `--json`                                                                 | Audits the published output before packaging ([verify](data.md#verify)): the manifest exactly as the tool writes it, every published file and byte, image content, every entry against its file, the committed lock and the paths and copy rules of the current profiles (it does not re-encode), nothing unsafe to ship, nothing an interrupted build left, and in generation mode the retained generations and unknown entries. Reads only: no claim, cache, credential or network access.                                                                                                                                                                                                                                                                            |
| `doctor`      | `--config`, `--json`, `--offline`                                                    | Diagnoses the tool and the project read only ([doctor](#doctor)): tool, Node, platform and encoder versions, then the checks config, lock, cache (every locked original hashed), output root and, unless `--offline`, read access (one HEAD of a locked original through the read transport) and writer access (one HEAD signed with the writer key, only when its variables are set). Never writes, takes no claim; `--offline` resolves no credential and sends no request.                                                                                                                                                                                                                                                                                           |
| `cache prune` | `--config`, `--json`, `--dry-run`                                                    | Removes from the local cache what the committed lock does not reference, plus leftovers of crashed runs, while no other run uses the cache ([prune](data.md#cache-prune)); `--dry-run` inspects and reports the same without changing anything. Never touches storage or `sourceDir`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Successful reports go to stdout, failed ones to stderr; their contents follow the
[report contract](reports.md). Exit codes follow the [error contract](errors.md):
0 success, 1 local I/O failure, 2 invalid config or missing
credential variables, 3 planned command, 4 usage error, 5 rejected credentials, 6 transient
transfer failure, 7 bytes that differ from the lock, 8 invalid data (for
example a directory given as a file, or selected originals that cannot be used, an invalid committed
lock, or unconfirmed removals), 9 output conflict, 10 not found (for example a missing source
directory). Errors never include raw details. Planned commands parse their flags fully and then
report `NOT_IMPLEMENTED` (exit 3) with the policies they accept and the values received (`dryRun`); nothing is read, written or transferred.

## Doctor

Each check ends `ok`, `notice` (usable, but something needs attention: no lock yet, originals not
cached so an offline build would fail, work files of an interrupted build, or storage answering
without a locked original to confirm it against), `failed` or `skipped` (with the reason:
`--offline`, no writer variables, no valid config, or no valid lock for the cache check). A
failing check never stops the later ones, except that a config that is missing or invalid skips
all of them and the cache check needs a valid lock. The first failed check in that order is the report's error, so the exit code names the first
kind of problem: `CONFIG_INVALID` 2 (config, missing credential variables, a redirect),
`AUTH_FAILED` 5, `TRANSIENT_TRANSFER` 6, `INTEGRITY_MISMATCH` 7 (a corrupt cache entry,
`CACHE_CORRUPT`, or a stored original of another size), `INVALID_DATA` 8 (an invalid lock),
`OUTPUT_CONFLICT` 9 (an output root a build refuses, or a cache directory another project or tool
owns), `NOT_FOUND` 10 (a missing config file, a locked original missing in storage, or a missing
output parent), `IO_FAILED` 1 for any other local failure; other storage answers map as in
[R2](../guides/r2.md).

Read access asks for the first locked original and is `ok` when storage answers with its locked
size; a HEAD does not read the bytes, so it never proves them (pull and build verify them by
hash). Without a lock it asks for a key no original can have, which only shows that storage
answers (a notice). Writer access is `ok` only when storage finds that locked original with the
writer key; a not-found answer, which a wrong bucket also gives, is a notice. It never proves
write permission: `doctor` never writes.

Report facts: `toolVersion`, `nodeVersion`, `platform`, `arch`, `sharp`, `libvips`, `libwebp`,
`libvipsThreadsPerImage`, `offline`, then for a loaded project `projectId`, `configFilePath`,
`readTransport`, the measured `lockedAssetCount`, `objectCount`, `cachedCount`, `missingCount`,
`damagedCount`, `outputRootState` and `probedKey`, and `checks`: one row per check with `check`,
`status`, `finding` and, when it failed, `code` and `details`. They hold counts, IDs, hashes, object
keys and variable names, never a credential value: resolved keys are redacted like every report.

## Target CLI

| Command     | Planned flags                     | Target behavior                                                                      |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------------ |
| `remote gc` | `--config`, `--json`, `--dry-run` | Deferred, explicitly planned administrative operation; never part of build/push/pull |

Cancellation and meaningful exit codes apply to every command. Ctrl+C ends local commands at once,
as usual; `push`, `pull`, `build` and `cache prune` take over the first Ctrl+C (also SIGTERM on
POSIX systems, and Ctrl+Break on Windows) and stop cleanly with `CANCELLED` (exit 130). Pressed
during its local preview, `push` lets the preview finish (hashing is not interrupted) and stops
before any credential is read; later, it stops by cancelling its transfers and aborting its
multipart uploads; up to the lock rename, its commit point, the previous lock stays and the objects
stored so far stay stored unreferenced. `pull` cancels its downloads and removes their part files.
`build` cancels its downloads, lets the running conversions (at most `limits.imageConcurrency`)
finish, starts none of those waiting for their turn and stops before its next asset, staged file
or publication step, removing its staging; once its output is being published it completes or
rolls back as for any failure. `cache prune` stops before its next file and reports what it removed
(a dry run only reads and keeps the default: Ctrl+C ends it at once). A second signal ends the
process at once. `build --offline` must not initialize transport credentials or contact R2.

`push` needs write credentials; ordinary build/pull uses the configured read transport on cache misses: no credentials for `public-http`, read-only credentials for `s3-readonly`. A warm verified cache needs none. A build without the read variables on a cold cache, as in a fork's CI job, stops with `CONFIG_INVALID` naming them before any request; restored from a cache, `build --offline` needs none ([CI](../integration.md#ci)). `pull --restore-sources` is opt-in, runs only once every original is cached, and writes only missing source files; it never replaces an existing one, so an author's edit survives. Default cache retrieval never touches the source directory.

Automatic lifecycle usage belongs in consumer scripts: `prebuild` or an explicit preparation task, not install-time npm hooks that unexpectedly retrieve large assets. `scan`/`push` are deliberate author actions and must never run automatically in ordinary CI builds.
