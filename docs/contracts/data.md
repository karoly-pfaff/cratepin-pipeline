# Source lock, policies and runtime manifest

## Configuration

`cratepin.config.json` declares the schema version, project slug, source/cache/lock paths, the owned output directory and mode, object prefix, read transport, R2 environment variable names, media profiles and limits. The complete schema, defaults and migration policy are in [configuration file](config.md). No secret values in config, locks, manifests or logs.

## Source inventory

`scan` and `inventorySources(project)` list the files under `sourceDir` that `sources.include`
selects ([matching rules](config.md#sources)), sorted by path in code-unit order. Each entry has the
forward-slash `path` relative to `sourceDir`, the `sha256` and `bytes` of the raw file, the
`mediaType` from its extension and its `category`. Files are hashed one at a time as streams, so
memory does not require buffering each original. A file larger than `limits.maxSourceBytes` is refused
before it is opened; a file that grows after that check is read only up to one byte past the
limit and then refused. The inventory only reads: nothing is written, moved, deleted or uploaded.
Paths are recorded as stored on disk; a name in decomposed Unicode form (for example from an old
macOS volume) is kept as it is (its logical ID is composed, see below), and directories spelled in
different letter case (`Images/a.png`, `images/b.png`) are not reported.

Findings are sorted by path and code. `path` is the source path (`.` for `sourceDir` itself),
or a config path starting with `/` for findings about the configuration.

| Code                 | Blocks the inventory | Meaning                                                                |
| -------------------- | -------------------- | ---------------------------------------------------------------------- |
| `NOT_A_REGULAR_FILE` | yes                  | A link, junction or special file anywhere in `sourceDir`; not followed |
| `UNREADABLE_SOURCE`  | yes                  | A file or directory that cannot be read; names the system error code   |
| `UNPORTABLE_PATH`    | yes                  | The path is not [portable](config.md#rules), e.g. `GENERA~1.png`       |
| `UNSUPPORTED_MEDIA`  | yes                  | The extension is not a supported format                                |
| `CATEGORY_MISMATCH`  | yes                  | The format does not suit the category, e.g. a PNG among voice lines    |
| `SOURCE_TOO_LARGE`   | yes                  | Larger than `limits.maxSourceBytes`; never read past the limit         |
| `CASE_COLLISION`     | yes                  | Paths that differ only in letter case or Unicode form; names them all  |
| `DUPLICATE_CONTENT`  | no                   | Files with identical bytes; they share one stored original             |
| `UNMATCHED_PATTERN`  | no                   | An include pattern selects no file (`/sources/include/<index>`)        |

`scan` fails with `INVALID_DATA` (exit 8) when any blocking finding exists and lists every
finding; notices accompany a successful report. A missing source directory is `NOT_FOUND`
(exit 10). `isBlockingIssue` tells the two kinds apart for library callers.

## Source catalog

`catalogSources(inventory, config.assets)` gives every inventoried original its logical ID and
the metadata authored in [`assets`](config.md#assets): optional `locale`, `role`, `profile` and
`licence`. The ID is the entry's `id` or, without one, the path without its last extension in
composed Unicode form (NFC); it never depends on the content hash. Assets are sorted by ID. `scan`
reports the catalog: each row holds the ID, the inventory fields and the authored metadata.

| Code             | Meaning                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `MISSING_SOURCE` | An `assets` entry names a file the inventory does not contain (`/assets/<index>/source`) |
| `INVALID_ID`     | The ID derived from the path is not portable, e.g. `hero .png`; give an explicit `id`    |
| `DUPLICATE_ID`   | Several files would get one ID, ignoring letter case, e.g. `cat.png` and `cat.webp`      |

All three block the scan. Identity never changes silently:

- A format change (`cat.png` to `cat.webp`) keeps the derived ID.
- A renamed file whose `assets` entry still names the old path fails with `MISSING_SOURCE`.
- A renamed file without an entry gets a new derived ID. Compared with the committed lock, the
  old ID is removed and the new one added with the same bytes; the preview reports this as an
  identity change and an `IDENTITY_CHANGED` notice at the new path. To keep the old ID, add an
  `assets` entry with that `id`.
- Every derived ID is a generated guess: new IDs are listed in the `scan` and `push --dry-run`
  previews, and the lock is written only by a push and committed by the author after reviewing
  its diff. The tool treats structured content such as
  JSON as opaque originals: it never follows or rewrites references inside it; mapping application
  content to logical IDs is the consumer's job.

## Source lock

The lock file (`lockFile`, default `cratepin-lock.json`) is committed to Git and lists every original
a project's builds may use. Authored metadata stays in the config's `assets` list; the lock holds
the resolved records:

```json
{
  "schemaVersion": 1,
  "projectId": "example-project",
  "assets": [
    {
      "id": "character.fox",
      "source": "scenes/forest/images/characters/fox.png",
      "sha256": "FULL_SOURCE_SHA256",
      "bytes": 48213,
      "mediaType": "image/png",
      "category": "image",
      "objectKey": "cratepin/v1/projects/example-project/sources/sha256/FULL_SOURCE_SHA256",
      "role": "actor"
    }
  ]
}
```

- Records are sorted by ID in code-unit order, fields appear in the order above, and `locale`,
  `role`, `profile` and `licence` appear only when authored. The file has two-space indentation and
  a final newline. It holds no time, machine name or absolute path, so the same sources produce the
  same bytes on every machine; `lockDigest` is the SHA-256 of that text.
- The object key is `<objectPrefix>/projects/<projectId>/sources/sha256/<sha256>`: content addressed
  and inside the project's own namespace. A rename does not need new remote bytes. Different
  projects are isolated; global deduplication is an optional later design, not an unsafe
  cross-project deletion assumption.
- Reading a lock (`loadCommittedLock`, `validateLock`) refuses, with the path of each problem:
  a schema version above 1 (`LOCK_UNSUPPORTED`: a newer tool wrote it), and as `LOCK_INVALID` a
  missing or malformed version, a lock of another project, unknown or duplicate fields, malformed
  values, an object key that is not this project's key for the record's `sha256` (so an edited
  hash or key cannot pass), an unsupported source extension, a media type that does not match the
  extension, an unsuitable category, a record larger than `limits.maxSourceBytes` (never retrieved
  or read), and two records with one ID or one source (ignoring letter case and Unicode form). Checks run in stages (JSON, shape, relations), so later problems appear
  once earlier ones are fixed. A missing lock file means the project has no lock yet. Changing
  `objectPrefix` makes every key of the existing lock invalid; this is reported once, at `/assets`,
  with the way forward: the originals belong under new keys, so move the lock aside, then scan and
  push (the old objects stay stored). A changed `projectId` makes it another project's lock.
- The lock, not the config, is what builds use: authored metadata reaches a build only through
  the next scan and push.
- **Staged and final.** `stageLock` turns a catalog without blocking findings into a lock; it is
  only staged. The committed lock text comes only from a `FinalizedLock` (`committedText()`),
  which only `FinalizedLock.fromVerifiedObjects` creates. It requires evidence for every
  referenced object: the key plus the SHA-256 and length the transfer code measured in storage
  during this push, also for objects an earlier lock already pinned, because storage, the bucket
  or the lock may have changed since. Contradicting evidence fails with `INTEGRITY_MISMATCH`
  naming the first contradicted ID, missing evidence with `NOT_FOUND` naming the first ID without
  any. The check is only as trustworthy as the code that measured the evidence. The type is
  nominal, so a look-alike object does not type-check, and it is frozen together with its copy of
  the lock. Only `push` writes the lock file, through `writeFinalizedLock`: the project layout
  is checked, the lock on disk must still be the one the push started from (otherwise a pull or
  another push happened meanwhile, `OUTPUT_CONFLICT`; concurrent pushes on one checkout are not
  supported, as this check and the rename are not atomic together), a lock with the same content
  (after canonical serialization) is left untouched, and
  otherwise the text goes to a new temporary file next to the lock, is flushed to disk, the
  layout is checked again, and the file is renamed over the lock in one step. Temporary files an
  interrupted earlier write left (`<lock>.<uuid>.tmp`) are removed first. On any failure the
  temporary file is removed and the previous lock stays exactly as it was.

The raw source hash is calculated before any decode, resize or metadata stripping. Logical IDs
persist independently of extensions and optimization choices. The lock's SHA-256 is not an S3 ETag:
an R2 object may be multipart, so downloaded bytes are hashed rather than equality inferred from
an ETag. Storage metadata may record the SHA-256 and length, but the lock and the actual bytes are
the integrity authority.

## Lock diff and upload plan

| Code               | Blocks | Meaning                                                                                                           |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `SOURCES_MISSING`  | yes    | At `.`: no original is present while the committed lock lists some                                                |
| `IDENTITY_CHANGED` | no     | At the new source: locked bytes now have a new ID, usually a rename; an `assets` entry with the old `id` keeps it |

`diffLocks(committed, staged)` compares a staged lock with the committed one by logical ID:
`added`, `changed` (with the fields that differ), `unchanged`, `removed`, and `identityChanges`
(a removed ID whose bytes reappear under an added ID). `planUploads(committed, staged)` groups
records by object key: `toUpload` (referenced only by the staged lock; a push uploads it, or
verifies it if storage already has it), `alreadyLocked` (referenced by the committed lock too: no
upload, but a push reads it back and hashes it again before finalizing) and `keptUnreferenced`
(referenced only by the committed lock). Both use the two
locks alone: storage is never listed, so "latest remote content" decides nothing.

A removed ID is not a deletion instruction: its stored original stays, and `keptUnreferenced`
lists it with its byte count. Remote cleanup is a separate, deliberate operation.

`scan` reports the catalog with `addedIds`, `changed` (rows of `id` and `changedFields`),
`removedIds`, `identityChanges` (rows of `fromId` and `toId`) and `unchangedCount`.
`push --dry-run` (reported under that name) adds the upload plan: `uploadCount`, `uploadBytes`,
`uploads`, `alreadyLockedCount`, `keptUnreferencedCount`, `keptUnreferencedBytes`,
`keptUnreferenced` (rows of `objectKey`, `bytes`, `sha256` and the `ids` list) and the digest of
the staged lock. Neither writes any file, reads any credential or contacts storage.

Both fail with `INVALID_DATA` (exit 8), still listing the catalog, when the committed lock is
invalid (its `LOCK_INVALID`/`LOCK_UNSUPPORTED` issues), when a blocking finding exists, or when
the source directory holds none of the originals a non-empty committed lock lists (the
`SOURCES_MISSING` issue: a fresh checkout before the originals are restored, which would
otherwise empty the lock). Partly missing originals are not detected: they look exactly like
deliberate removals and appear as removed IDs, so a real push will need an explicit confirmation
of removals before it writes a lock without them.

## Verified cache and pull

`pull` makes every original the committed lock pins available in the local cache (`cacheDir`),
verified against the lock's SHA-256 and byte length. It needs a valid committed lock: without one
it fails with `NOT_FOUND` (exit 10), with an invalid one with `INVALID_DATA` (exit 8) and its lock
issues. Each object the lock references is handled once, `limits.concurrency` (or
`--concurrency`) at a time:

- its cache entry is hashed completely; only exactly the locked bytes are a hit. A corrupt entry
  is moved to the cache's quarantine and reported as a `CACHE_CORRUPT` notice;
- a miss is downloaded by its exact locked key through the configured read transport, never by
  listing storage. The transport is created on the first miss only, so a warm cache needs no
  credential and no network, also without `--offline`;
- a failed object does not stop the others; every ID whose object failed is listed.

| Code               | Meaning                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| `OBJECT_MISSING`   | Storage has no object under the locked key                                          |
| `OBJECT_FORBIDDEN` | Storage refused the read (credentials, permissions, or a URL that is not public)    |
| `OBJECT_CORRUPT`   | The downloaded bytes differ from the locked SHA-256 or length; nothing was cached   |
| `DOWNLOAD_FAILED`  | Any other failure, such as a transfer that kept failing                             |
| `CACHE_MISS`       | Offline: the original is not in the cache, and nothing is downloaded                |
| `CACHE_CORRUPT`    | Notice: the cache entry was corrupt and moved to the quarantine                     |
| `SOURCE_KEPT`      | Notice: `--restore-sources` left an existing source file that differs from the lock |
| `RESTORE_SKIPPED`  | Notice at `.`: `--restore-sources` restored nothing, because an original is missing |

Issues name the source path; the message gives the ID, the SHA-256 and the reason, never raw
error text. A pull that left originals out fails with the code of the first affected ID in lock
order (for example `NOT_FOUND`, exit 10, or `AUTH_FAILED`, exit 5) and `failedCount`; offline
misses fail with `NOT_FOUND` and `missingCount`. A storage address that redirects is
`CONFIG_INVALID` (exit 2): redirects are never followed. A pull that finds the cache being pruned
fails with `OUTPUT_CONFLICT` (exit 9) and the prune's `claimFile`
([concurrent runs](../guides/safety.md#cache-model)). Once the cache was checked, the report
has `objectCount`, `cachedCount`, `downloadedCount`, `downloadedBytes` and `quarantinedCount`,
whatever happened afterwards; a pull that stops before that (no lock, missing credential
variables, a foreign cache directory, cancellation) reports only its error.

`--offline` never creates the read transport: no credential is resolved and no request is sent.
It never falls back to anything else either: not to storage listings or a remote latest, and not to
files in `sourceDir`, even identical ones; a miss is a miss. The CLI tests show this by running
`pull` under a preload that makes `fetch`, socket and TLS connections, HTTP(S) requests and every
DNS function fail and report the attempt, with no variable of its own in the environment: with
`public-http` (where an attempt would reach `fetch`) a warm cache succeeds online and offline and a
cold one fails offline with every ID and its locked hash, all without an attempt; with
`s3-readonly` a warm cache needs no credential variable. `build --offline` and
`build --dry-run --offline` resolve their inputs the same way and fail on a cold cache with every
miss, before anything is written to the output.
Ctrl+C cancels downloads and restore copies at once; hashing one cache entry or source file runs
to its end, and the pull stops before the next one.
`--dry-run` hashes the cache entries and reports `objectCount`, `cachedCount`, `wouldDownload`
(rows of `objectKey`, `sha256`, `bytes` and `ids`) and `wouldDownloadBytes`; it writes nothing
(not even a quarantine move), resolves no credential and sends no request. With `--offline` it
lists no downloads and fails like a real offline run.

`--restore-sources` writes the locked source files that are missing from `sourceDir`, and only
once every original is in the cache. Each is copied from its verified entry, checked again while
it is copied, into a hidden temporary file next to the target (`.<name>.<uuid>.restore`; one a
crashed restore left is removed before the source is restored once it is untouched for an hour, as
a younger one may still be written by another pull), which then gets the source's name only if
that is still free. An existing file is never replaced: an identical one counts as
unchanged, a different one (an edit, or anything that is not a regular file) is kept and
reported; so is a file someone created while the restore ran, after it is compared with the
lock. The report lists `restoredSources`, `unchangedSourceCount` and `keptSources`
(`wouldRestoreSources` with `--dry-run`). A restore that stops (a source that cannot be read while
comparing, a file where a directory belongs, a cache entry that changed, cancellation) fails the
report with that error and still lists what was compared and restored until then.

## Build dry run

`build --dry-run` reads the committed lock, the cache and the output root and reports what a
build would do; it writes nothing (no claim, cache directory, derivative or output), resolves no
credential and contacts no storage, online or offline. Facts:

- **Output**: `projectId`, `outputRoot`, `outputMode`, `outputUrlPath`, `manifestFile`, `dryRun`, `outputRootState`
  (`absent`, `empty` and `owned` may be built into, an owned root only when it passes the same
  checks a build makes for its mode, see [build](#build); `parent-missing`, `not-a-directory`,
  `not-owned`, `foreign-project`, `mode-changed` and `marker-invalid` are refused with the codes
  below) and `publishedManifest` (`absent`, `present` or `unreadable`). When an earlier build left
  unfinished work, the notice `BUILD_LEFTOVERS_PENDING` says a build would first recover it (in
  path-preserving mode that may put a previous output back); the dry run compares with the
  output as it is now. A refusal a build meets before recovering anything comes without the
  notice: the root's marker, a link or file at the work directory
  (`WORK_DIRECTORY_NOT_A_DIRECTORY`) or a path-preserving build's work in generation mode
  (`PATH_PRESERVING_WORK_LEFT`).
- **Originals**: `objectCount`, `cachedCount`, and online `wouldDownloadCount` and
  `wouldDownloadBytes`, offline `missingCount`.
- **Assets**: `assetCount`, `copiedCount`, `reusedCount` (a cached derivative that would be reused),
  `wouldConvertCount`, `refusedCount`, `isPlanComplete` and, once every output is known,
  `generation`; `assets` rows (`id`, `profile`, `output`: `copied`, `reused`, `wouldConvert`, and
  `outputPath` when known; a refused asset is a row of `source` and `output: refused`).
- **Changes**: `addedIds`, `removedIds` and `changedIds` (known outputs whose bytes or URL
  differ) against a readable published manifest (without one, every locked ID counts as added),
  `pendingIds` (outputs not known before conversion) and `extensionChanges` rows (`id`, `source`, `outputPath`, `fromExtension`, `toExtension`) for
  every output path already certain: a known output's, or the only one a copy, same-format or
  strict WebP profile can give (a flexible WebP profile may keep either and is pending).

It fails where a build would, in the order a build meets it. The plan comes first, before any
I/O: clashing paths or undefined profiles end the dry run there (`INVALID_DATA`, exit 8, with
`problemCount`; the report has only `projectId`, `outputRoot`, `outputMode`, `outputUrlPath`,
`manifestFile`, `dryRun`, `lockedAssetCount` and `plannedAssetCount`, and the plan's issues). Otherwise: an output root the build must not touch
(exit 9, or 10 when its parent is missing), originals missing offline (`NOT_FOUND`, exit 10,
`missingCount` per stored object, one `CACHE_MISS` per ID), then assets it would refuse while
converting (`INVALID_DATA`, exit 8, with `failedCount`). Issues are listed sorted by path. It cannot see problems that only appear while converting or publishing.

| Code                      | Meaning                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OUTPUT_PARENT_MISSING`   | The output root's parent (usually `public/`) does not exist; the tool never creates it                                                                                             |
| `OUTPUT_NOT_A_DIRECTORY`  | A link, junction or file where the output root's parent must be a real directory (a root that is one fails the layout check, `CONFIG_INVALID`)                                     |
| `OUTPUT_NOT_OWNED`        | Content without `.cratepin-output.json`; move it aside and build again                                                                                                             |
| `OUTPUT_FOREIGN_PROJECT`  | The marker names another project                                                                                                                                                   |
| `OUTPUT_MODE_CHANGED`     | The marker names the other output mode                                                                                                                                             |
| `OUTPUT_MARKER_INVALID`   | The marker is unreadable or not this tool's                                                                                                                                        |
| `OUTPUT_PATH_COLLISION`   | Two assets would share a file or directory ignoring letter case, or a file meets a directory                                                                                       |
| `OUTPUT_PATH_RESERVED`    | An output would take a name the tool writes at the top of the output: `cratepin-manifest.json`, `.cratepin-output.json` (or a marker being written) or `.cratepin-generation.json` |
| `PROFILE_UNKNOWN`         | The asset's profile is not defined                                                                                                                                                 |
| `OUTPUT_TYPE_UNEXPECTED`  | The original's content is another image type than its name says                                                                                                                    |
| `EXTENSION_CHANGED`       | Notice: the asset is published under another extension; hosts look it up by ID                                                                                                     |
| `CACHE_MISS`              | Offline, a locked original is not in the cache                                                                                                                                     |
| `CACHE_CORRUPT`           | Notice: a cache entry does not hold its locked bytes; a build replaces it (online)                                                                                                 |
| `BUILD_LEFTOVERS_PENDING` | Notice: an earlier build left unfinished work, which a build recovers first                                                                                                        |

Conversion refusals use their reasons as codes, such as `IMAGE_UNREADABLE` or `ROLE_NEEDS_COPY`
([image policies](../guides/images.md)).

## Build

`build` publishes the outputs of the committed lock in either output mode
([path-preserving](../guides/safety.md#path-preserving-publication) or
[generation](../guides/safety.md#generation-publication)). It plans first, exactly as the
dry run does, refuses an output root it may not touch from its marker alone, takes the `build`
claim in the cache, recovers what an interrupted build left, checks that the root may be
published into, gets every original like `pull` (online it downloads misses through the read
transport; `--offline` never does), converts or reuses each output, and publishes the complete
output. The check and the publication depend on the mode:

- **Path-preserving**: the root needs a readable listing and nothing the tool did not write
  (`OUTPUT_LISTING_INVALID`, `UNLISTED_OUTPUT_ENTRY`); the next root is staged and swapped in by
  two renames; Ctrl+C is honoured until just before the first rename.
- **Generation**: `generations` must be a real directory (`OUTPUT_NOT_A_DIRECTORY`) and a
  present root manifest must be the tool's (`OUTPUT_MANIFEST_INVALID`); other entries are kept
  and reported (`UNKNOWN_OUTPUT_NAME`); the generation is staged and placed, then the manifest is
  switched in one rename; Ctrl+C is honoured until the generation is placed.

Nothing is published unless every asset was built; the previous output then stays exactly as it
was.

The report has the dry run's output facts (`projectId`, `outputRoot`, `outputMode`,
`outputUrlPath`, `manifestFile`, `dryRun: false`) and:

- **Publication**: `publication` (`published`, `unchanged` when the root already held exactly this
  output, or `not-published`), `recovery` (`none`, `rolled-back` or `completed`, see below),
  `removedFileCount` (files of old outputs and crashed runs removed) and, once every output is
  known, `generation`; in generation mode after a switch, `previousGeneration`, the generation
  the replaced manifest named, which is kept.
- **Originals**, once the cache was checked: `objectCount`, `cachedCount`, `downloadedCount`,
  `downloadedBytes` and `quarantinedCount`, as `pull` reports them.
- **Sizes**, once every asset was built: `assetCount`, `sourceBytes`, `outputBytes`, `savedBytes` (may be zero or negative),
  `grewCount`, how the outputs came to be (`copiedCount`, `reusedCount`, `madeCount`,
  `remadeCount`) and `assets` rows of each asset's real sizes, dimensions, choice and notices.
- **Issues**, sorted by path: what recovery and publication noticed, originals that could not be
  read, refused assets, `EXTENSION_CHANGED` and conversion notices such as `SIZE_GREW`.

It fails in the order a build meets each problem: the plan (`INVALID_DATA`, exit 8, reported as
by the dry run), an output root it must not touch (exit 9, or 10 when its parent is missing),
another live build or prune (`OUTPUT_CONFLICT`, exit 9), an interrupted swap it cannot tell apart
or a backup still held open (exit 9), then, after recovery, a root it may not publish into (exit 9),
originals missing offline (`NOT_FOUND`, exit 10) or not retrievable, assets it refuses
(`INVALID_DATA`, exit 8, with `failedCount`), a manifest or listing holding a value that must not
ship (`INVALID_DATA`, exit 8, `MANIFEST_UNSAFE_VALUE`, see [verify](#verify); the dry run reports
it too once every output is known), cancellation, or a failed publication. A failure
after recovery carries the output, publication and recovery facts, the recovery notices and the
facts of the steps it reached; a failure of recovery itself, or before the claim, carries only
the error, which names the path that stayed (for example the backup).

| Code                             | Meaning                                                                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNLISTED_OUTPUT_ENTRY`          | The owned root holds an entry the tool did not write; move it elsewhere (exit 9)                                                                         |
| `OUTPUT_LISTING_INVALID`         | The owned root's generation listing is missing or damaged, so its files cannot be told apart (exit 9)                                                    |
| `OUTPUT_IN_USE`                  | A program holds open what a step must rename or remove (the root, its backup, a generation or the manifest); `path` names it (exit 9)                    |
| `SWAP_INCOMPLETE`                | Neither the new nor the previous output could be put in place; `backupDir` holds the previous one (exit 9)                                               |
| `INTERRUPTED_SWAP_UNCLEAR`       | An interrupted swap left a state recovery cannot tell apart; nothing was changed (exit 9)                                                                |
| `WORK_DIRECTORY_NOT_A_DIRECTORY` | A link or file is where the work directory next to the root or its `claims/` belongs; nothing was changed (exit 9)                                       |
| `PATH_PRESERVING_WORK_LEFT`      | Generation mode: a path-preserving build left work next to the root; build once in that mode or remove it (exit 9)                                       |
| `STAGED_TREE_INVALID`            | The staged output did not hold exactly what was built; nothing was published (`INTEGRITY_MISMATCH`)                                                      |
| `GENERATION_DAMAGED`             | Generation mode: the published generation's files changed; delete its directory, it is generated (exit 9)                                                |
| `GENERATION_COLLISION`           | Generation mode: another digest is published under the same short name; nothing was replaced (exit 9)                                                    |
| `OUTPUT_NOT_A_DIRECTORY`         | Generation mode: a link or file is where `generations` belongs (exit 9)                                                                                  |
| `MANIFEST_UNSAFE_VALUE`          | The manifest or listing a build would publish holds a value that must not ship; nothing was published (`INVALID_DATA`, exit 8)                           |
| `GENERATION_KEPT`                | Notice: an old generation could not move to the trash (an open file, or the trash is not a real directory); it stays whole until a later build publishes |
| `UNKNOWN_OUTPUT_NAME`            | Notice: generation mode keeps an entry the tool did not write; the manifest never serves it                                                              |
| `SWAP_ROLLED_BACK`               | Notice: an interrupted build had moved the output aside; recovery put it back                                                                            |
| `SWAP_COMPLETED`                 | Notice: an interrupted build had already published; recovery moved its leftover backup to the trash                                                      |
| `BACKUP_KEPT`                    | Notice: the previous output could not be moved to the trash; the next build removes it                                                                   |
| `OUTPUT_TRASH_KEPT`              | Notice: a path in the output's staging, trash or temporary manifest stays (open, changed, not the tool's, or the listing proving the rest)               |
| `OUTPUT_MANIFEST_INVALID`        | Generation mode: the root manifest is damaged or not this project's and mode's; it is never replaced (exit 9)                                            |

## Verify

`verify` audits the published output against the committed lock and config before an application is
packaged. It reads only: no claim, no cache, no credential, no network access. The output root
must be this project's (its refusals and exit codes are the build's) and hold a publication
(`NOT_FOUND`, exit 10, before the first build). Then:

- **Leftovers**: anything an interrupted build left (the work directory next to the root, with
  the claims of a build that died, or in generation mode a staging, trash or temporary manifest)
  would ship: `INTERRUPTED_PUBLICATION`. A build still running looks the same.
- **Manifest**: strictly parsed and byte for byte the text the tool writes (known fields only,
  sorted IDs, field order, spacing), for this project and output mode; its generation is the
  digest of the published listing: else `MANIFEST_INVALID`.
- **Files**: exactly the listed files and tool files, every byte hashed, no link or other entry,
  each PNG, WebP, GIF or JPEG with the leading bytes of its media type: `OUTPUT_MISSING`,
  `OUTPUT_MISMATCH`, `UNLISTED_OUTPUT_ENTRY`.
- **Entries**: each entry's URL is the configured URL path and a listed file's encoded path, with
  that file's hash, size and media type, and each file has exactly one entry: `MANIFEST_MISMATCH`.
- **Dimensions**: `width` and `height`, when present, must be a complete pair of positive safe
  integers (`MANIFEST_INVALID` otherwise). After the tree passes its byte/type/regular-file
  audit, each dimension-bearing PNG or WebP entry is compared with its published image header;
  a mismatch, unreadable header or dimensions on another media type is `MANIFEST_MISMATCH`.
  This reads metadata without decoding pixels and needs no original or derivative cache. Copies
  remain valid without dimensions and are never decoded by this check.
- **Lock and profiles**: exactly the locked IDs, each with its record's source, hash, category,
  role and locale, at a path its current profile can give it, and a copy (also every print
  master) with the original's exact bytes: `MANIFEST_STALE`. The plan's own problems are
  reported under their codes (`PROFILE_UNKNOWN`, `OUTPUT_PATH_COLLISION`, `OUTPUT_PATH_RESERVED`). A changed encoder
  option (quality, resize box) can give the same paths: header checks prove the dimensions of
  the published bytes agree with the manifest, not that today's profile produced them. Build
  again after changing a profile; verify does not re-encode.
- **Unsafe values**: no string of the manifest or listing (keys included) holds a credential
  shape, an absolute path at its start or a backslash, a URL with a scheme, a parent-directory segment, a
  signed-URL parameter in a query, a raw query, fragment or user part in a `url`, or the host name
  (without a port) of the project's `publicBaseUrl`: `MANIFEST_UNSAFE_VALUE`, at `<file>#<JSON pointer>` (a
  credential-shaped key is not echoed). Verify resolves no credential, so it knows credentials by
  shape only. A build runs the same scan before it publishes and fails as `INVALID_DATA`
  instead.
- **Generation mode**: every retained generation is audited against its own listing, and every
  entry the tool did not write (`UNKNOWN_OUTPUT_NAME`) blocks, as it would be packaged.

The report has `projectId`, `outputRoot`, `outputMode`, `manifestFile`, `generation`,
`assetCount`, `fileCount` and `byteCount`, and every issue sorted by path. Any issue fails it:
`OUTPUT_CONFLICT` (exit 9) when something would ship that the tool did not publish
(`INTERRUPTED_PUBLICATION`, `UNKNOWN_OUTPUT_NAME`, `UNLISTED_OUTPUT_ENTRY`), else
`INTEGRITY_MISMATCH` (exit 7) for bytes, else `INVALID_DATA` (exit 8).

## Cache prune

`cache prune` decides from the committed lock and the cache's own names alone; storage is not
consulted. It needs a valid committed lock (absent: `NOT_FOUND`, invalid: `INVALID_DATA`). Without
a cache it succeeds with `cacheExists: false`. The report has `referencedCount`, `referencedBytes`
and `missingReferencedCount` (locked originals with no entry), `referencedDerivativeFileCount` and
`referencedDerivativeFileBytes` (outputs and records of derivatives made from a referenced original,
which stay), `unknownNames`, and either
`removed` (rows of `kind`, `name` relative to the cache root, `bytes`), `removedBytes` and
`removedDeadClaimCount`, or with `--dry-run` `wouldRemove`, `wouldRemoveBytes`, `deadClaimFiles`
and `liveClaims` (rows of `claimFile`, the name in the cache's `claims` directory, and, when
readable, `command`, `pid` and `host`). Kinds are `entry`, `derivative`, `derivativeRecord`, `part`, `quarantined` and `temporary`.
A real prune that finds another run's live claim, or a cache directory that is a link or junction,
fails with `OUTPUT_CONFLICT` (exit 9) before removing anything, its facts saying so; one that is
cancelled or fails midway fails with that error and still lists what it removed. Only `--dry-run`
hashes the referenced entries.

| Code                 | Meaning                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `CACHE_CORRUPT`      | Notice of a dry run: a referenced entry does not hold the locked bytes; it stays |
| `UNKNOWN_CACHE_NAME` | Notice: a name the cache layout does not explain; it is never touched            |
| `CACHE_IN_USE`       | Notice of a dry run: a run holds this claim, so a real prune would refuse        |

## Generated runtime manifest

The runtime manifest maps logical IDs to local **relative public URLs** with each output's real
bytes, media type and provenance; it never holds an endpoint, credential, signed URL, cache or
absolute path. The host's `publicUrl`/base-path helper resolves its URLs for `./`, subpath-hosted
Vite and Capacitor. A build writes it as `cratepin-manifest.json` at the top of the owned output
root, in both output modes ([build](#build)), and `build --dry-run` computes the same manifest and generation ([build dry run](#build-dry-run)). The name is reserved, as a
file and as a directory, in any letter case, like the output marker and the file listing: a
source whose output would take one fails with `OUTPUT_PATH_RESERVED`.
Its schema version is independent of the lock's:

```json
{
  "schemaVersion": 1,
  "projectId": "example-project",
  "outputMode": "path-preserving",
  "generation": "FULL_GENERATION_SHA256",
  "assets": {
    "character.cat": {
      "url": "assets/images/cat.webp",
      "mediaType": "image/webp",
      "bytes": 12345,
      "sha256": "FULL_OUTPUT_SHA256",
      "width": 512,
      "height": 512,
      "category": "image",
      "role": "actor",
      "locale": "hu",
      "source": "images/cat.png",
      "sourceSha256": "FULL_SOURCE_SHA256"
    }
  }
}
```

- **Assets** are keyed by logical ID in UTF-16 code-unit order (the text is written entry by entry,
  as `JSON.stringify` of an object would put integer-like IDs such as `10` first). Fields keep the
  order shown; `width` and `height` appear together as positive safe integers only for a
  converted image (a copy is never decoded),
  `role` and `locale` only when the lock has them. Hosts look entries up with `Object.hasOwn` or a
  `Map` and ignore fields a later version may add.
- **URL**: [`outputUrlPath`](config.md#output-url-path), then the output's path inside the owned
  tree, each segment percent-encoded (`a b.png` becomes `a%20b.png`; names of letters, digits and
  `._~-` stay as written). In path-preserving mode the output path is the source path, so a legacy
  `assets/images/cat.png` reference keeps working, unless the profile changed the format: then
  only the last extension changes (`cat.png` becomes `cat.webp`, `.PNG` stays `.PNG` when kept)
  and the build reports `EXTENSION_CHANGED`; hosts look such IDs up through the manifest (`source`
  maps a legacy path to its entry). In generation mode the path is
  `generations/<first 16 hex of the generation>/<output path>`; files keep their names, as the
  generation directory already changes with any byte.
- **Generation**: the SHA-256 of the generation listing, `.cratepin-generation.json`: every
  output file's path, SHA-256, byte count and media type, sorted by path, and nothing else (no
  project, URL, time or machine). It changes exactly when an output path or byte changes, is the
  same in both modes, and can serve as a host cache version. A build never overwrites a
  published generation directory: a name another digest already uses there is
  `GENERATION_COLLISION`.
- **Excluded**: profile, conversion choice, notices and savings (report facts), object keys,
  licences, encoder fingerprint, tool version, times, endpoints, buckets, `publicBaseUrl`, signed
  URLs and every cache, config or absolute path.

Output paths are checked before anything is read: two assets on one file, a directory spelled two
ways, a file where another asset needs a directory (all ignoring letter case, as Windows and macOS
do) fail with `OUTPUT_PATH_COLLISION`, naming both IDs; a flexible WebP profile is checked on both
paths it may take, so the outcome never depends on how well an image compressed. `.png → .webp` cannot transparently satisfy a hardcoded `.png` URL; hosts must resolve logical IDs via the generated manifest or request a compatibility output profile. Do not silently mutate content JSON or regex-rewrite references.
