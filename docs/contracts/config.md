# Configuration file

`cratepin.config.json` is a small, Git-tracked JSON file per project. It holds paths, the
project namespace, environment variable **names** for credentials, media profiles and limits —
never secret values. `cratepin init` writes a complete file with every default spelled
out except `outputUrlPath`, which follows `outputDir`; [examples/cratepin.config.json](../../examples/cratepin.config.json) shows a
realistic, shorter one.

## Rules

- Only `schemaVersion` and `projectId` are required. Every other field may be omitted and then
  takes the default below. Only an **absent** field gets a default: an explicit `0`, `false` or
  empty string is validated as given, and `null` is always invalid.
- Unknown fields are errors at every level, so typos and misplaced secrets cannot be ignored.
- Any string that looks like a credential is rejected with code `CONFIG_SECRET` and is never
  echoed: 32- or 64-character hex keys (also inside a longer string, but not in a URL's host name, so the standard public
  bucket host `pub-<32 hex>.r2.dev` is accepted), `AKIA…`/`ASIA…` keys,
  JWTs, private key blocks, URLs with user info, and signed URL parameters. The same applies to
  field names, which issue paths show as `[REDACTED]`.
- A field that appears twice in one object is an error: JSON would silently keep only the last
  value, which could hide an earlier one (for example a pasted credential).
- Relative paths resolve from the **directory of the config file**, never from the working
  directory. Paths use forward slashes, may not be absolute, may not contain `..`, empty or `.`
  segments, Windows device names (`CON`, `NUL`, `COM1.png`, …), 8.3 short names such as
  `GENERA~1` (they can alias a longer directory), segments ending in a dot or space, or
  characters reserved on Windows. `sourceDir`, `cacheDir` and `outputDir` may not lie inside
  `.git`, `.hg`, `.svn` or `node_modules`, also not through a link.
- Globs in `sources.include`, `sources.categories` and `profileRules` match paths relative to
  `sourceDir`. They follow the same rules and may also use `*`, `**`, `?`, `[...]` and `{a,b}`.
  Braces are expanded first and every alternative must itself be portable, so `{..,x}/**`
  is rejected; at most 64 alternatives and 64 brace groups are allowed. A segment made only of
  dots and character classes (`[.][.]`) is rejected because it could match `..`. A class that
  cannot work, such as the reversed range `[b-a]`, is rejected. Negation (`!pattern`) is not
  supported.
- `sourceDir`, `cacheDir` and `outputDir` may not be equal or nested and `lockFile` may not be
  inside any of them, compared ignoring letter case. None of them may be or lie in a directory
  named `.<name>.cratepin`: that is the work directory next to an output root
  (`public/.assets.cratepin` for `public/assets`), this project's or another config's,
  where builds stage, swap and remove output.
- `validate` also checks the real directory layout: every root stays inside the config file's
  directory even through links, the source, cache and output roots never contain each other
  (ignoring letter case), the lock file and config file stay outside them, no root and not the
  lock lies in a directory named `.<name>.cratepin` also through links or because the
  whole project does, and no root is itself a link ([safety](../guides/safety.md)).
- Nested objects follow their own table. A credential pair (`writer`, `s3-readonly` read) must be
  complete when given; `limits`, `webp` and `resize.fit` default field by field.

## Top-level fields

| Field            | Default              | Meaning                                                                                                  |
| ---------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `schemaVersion`  | required             | `1`. Any other value fails and lists the supported versions.                                             |
| `projectId`      | required             | Lowercase slug (`a-z`, `0-9`, `-`, at most 63) naming the project's R2 namespace.                        |
| `sourceDir`      | `assets/source`      | Local, Git-ignored directory with the original media.                                                    |
| `cacheDir`       | `.cratepin-cache`    | Local verified cache.                                                                                    |
| `lockFile`       | `cratepin-lock.json` | Committed source lock.                                                                                   |
| `outputDir`      | `public/assets`      | Owned output root; any dedicated subdirectory, never a directory named `public`.                         |
| `outputMode`     | `path-preserving`    | `path-preserving` or `generation` ([output safety](../guides/safety.md)).                                |
| `outputUrlPath`  | derived              | URL path at which `outputDir` is served, relative to the host's public root ([below](#output-url-path)). |
| `objectPrefix`   | `cratepin/v1`        | Prefix of every R2 object key.                                                                           |
| `sources`        | see below            | Which files are originals and their media category.                                                      |
| `r2`             | see below            | Credential variable names and the read transport.                                                        |
| `profiles`       | `{}`                 | Named media profiles; `copy` is built in.                                                                |
| `profileRules`   | `[]`                 | `{ "match": glob, "profile": name }`, first match wins.                                                  |
| `defaultProfile` | `copy`               | Profile for files no rule matches.                                                                       |
| `assets`         | `[]`                 | Per-file logical IDs and metadata ([below](#assets)).                                                    |
| `limits`         | see below            | Resource bounds.                                                                                         |

## Output URL path

Manifest URLs are relative to the host's public (web) root and never start with `/`, so a `./`
base, a subpath and Capacitor all resolve them. `outputUrlPath` is their first part: `""` or
segments of letters, digits and `._~-`, without a slash at either end and without `.` or `..`
segments. When absent it is derived from `outputDir`: the segments after its last segment named
`public` in any letter case (`public/assets` and `apps/web/public/assets` give `assets`,
`web/public/media/gen` gives `media/gen`). An `outputDir` without a `public` segment cannot be
derived and fails with `CONFIG_INVALID` at `/outputUrlPath` until the path is given; it is never
guessed. A derived value must follow the same rule as a given one: an `outputDir` such as
`public/my assets` (a space, `#`, `%` or a non-ASCII letter after `public`) fails the same way
instead of being encoded silently. `validate` reports the effective value.

## `sources`

| Field        | Default                                                                                   | Meaning                                                                            |
| ------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `include`    | images (`png gif svg webp jpg jpeg`) and audio (`mp3 ogg wav m4a`)                        | Non-empty list of globs relative to `sourceDir`.                                   |
| `categories` | `**/voice/**` voice, `**/effects/**` effects, `**/music/**` music, image extensions image | `{ "match": glob, "category": … }`, first match wins; unmatched files are `other`. |

Categories are `image`, `voice`, `effects`, `music` and `other`.

How patterns select files:

- Matching ignores letter case and Unicode normalization on every platform, so a project selects
  the same files on Windows, macOS and Linux: `**/*.png` also selects `HERO.PNG`. Case folding
  maps one character to one (Unicode simple case folding), so `?` still matches `ß`, and
  `straße` does not match `STRASSE`. Two files whose paths differ only in case or Unicode form
  are rejected (`CASE_COLLISION`); that comparison folds more broadly and also treats `ß` and
  `ss` as one.
- `**` matches any number of whole path segments, including none; `*` and `?` stay inside one
  segment.
- Wildcards track reachable pattern positions instead of backtracking. Within each segment,
  work is bounded by pattern length times the number of Unicode code points in the name;
  separated stars cannot cause exponential matching. Include, category and profile rules use
  this same matcher, including character classes and brace alternatives.
- Hidden entries, whose name starts with a dot (`.env`, `.git`, `.DS_Store`), are never listed,
  matched or read, whatever the patterns say. Files no include pattern selects are never opened.
- Links, junctions and special files anywhere inside `sourceDir` are not followed; each one
  blocks the scan even if no pattern would select it, because a linked directory could hide
  files from outside the source root.

Supported formats, by extension in any letter case: images `png gif svg webp jpg jpeg avif`,
audio `mp3 ogg opus wav m4a aac flac`, video `mp4 webm`, fonts `woff woff2 ttf otf` and `json`.
`image` needs an image format and `voice`, `effects` and `music` need an audio format; `other`
takes any supported format.

## `assets`

An optional list of entries, one per source file, holding what the file system cannot say:

```json
"assets": [
  { "source": "scenes/forest/images/fox.png", "id": "character.fox", "role": "actor" },
  { "source": "voice/hu/hello.mp3", "locale": "hu", "licence": "CC-BY-4.0" }
]
```

| Field      | Meaning                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`   | Required. The file's portable path relative to `sourceDir`; matched ignoring letter case.                                                                                                                                                                                                                                                                  |
| `id`       | Logical ID instead of the one derived from the path; follows the portable path rules.                                                                                                                                                                                                                                                                      |
| `category` | Category instead of the `sources.categories` rules; it must still suit the format.                                                                                                                                                                                                                                                                         |
| `locale`   | Language tag such as `en`, `hu` or `pt-BR`.                                                                                                                                                                                                                                                                                                                |
| `role`     | Lowercase slug saying what the asset is for, such as `actor`, `background` or `print-master`; when an original is converted (not when the config loads), `sprite`, `atlas`, `mask` and `data` accept only lossless WebP that keeps every sample and `print-master` only the copy profile ([special media](../guides/images.md#implemented-special-media)). |
| `profile`  | Media profile instead of `profileRules`; it must exist.                                                                                                                                                                                                                                                                                                    |
| `licence`  | Licence text such as `CC-BY-4.0`, one line of at most 200 characters.                                                                                                                                                                                                                                                                                      |

Without an entry, a file's logical ID is its path without the last extension, so
`images/cat.png` becomes `images/cat` and converting it to `images/cat.webp` keeps the ID. An
explicit `id` keeps the identity through a rename once the entry's `source` follows the file; a
rename without an entry changes the derived ID, which the scan preview reports as an identity
change. Explicit IDs must be in composed Unicode form (NFC). Keeping per-file metadata in the
config means one bad entry fails every command that loads the config, and many entries make the
file long; only files that need an override need an entry.
Two entries for one source, two entries with one `id` (ignoring letter case) and an unknown
`profile` are config errors. An entry whose source the scan does not find, and two files that
would get the same ID, fail the scan ([source catalog](data.md#source-catalog)).

## `r2`

| Field         | Default                                                                  | Meaning                                                                      |
| ------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `endpointEnv` | `R2_ENDPOINT`                                                            | Variable holding the account S3 endpoint ([below](#r2-endpoint)).            |
| `bucketEnv`   | `R2_BUCKET`                                                              | Variable holding the bucket name.                                            |
| `writer`      | `R2_WRITE_ACCESS_KEY_ID` / `R2_WRITE_SECRET_ACCESS_KEY`                  | Author upload credentials (`accessKeyIdEnv`, `secretAccessKeyEnv`).          |
| `read`        | `s3-readonly` with `R2_READ_ACCESS_KEY_ID` / `R2_READ_SECRET_ACCESS_KEY` | Build-side read transport ([read credentials](../guides/r2.md#credentials)). |

`read` is either `{ "transport": "public-http", "publicBaseUrl": "https://…" }` — a non-secret
HTTPS base URL (plain `http` only to a loopback host, for local tests) without user info, query or
fragment; objects are read from `<publicBaseUrl>/<object key>` — or `{ "transport": "s3-readonly",
"accessKeyIdEnv": …, "secretAccessKeyEnv": … }`. Every environment variable serves exactly one
purpose: endpoint, bucket, writer id/secret and read id/secret must all be different names, so CI
can be given the read variables without the writer's, and a key can never be printed as a bucket
name. Different names do not make different tokens: store a token scoped to reading the bucket
under the read names ([CI](../integration.md#ci)).

### R2 endpoint

The endpoint is the account's S3 API URL, `https://<account>.r2.cloudflarestorage.com`. The
bucket-scoped form the Cloudflare dashboard shows, the same URL followed by `/<bucket>`, is
accepted when its path is exactly the bucket named by `bucketEnv`, and is cut back to the account
URL; requests are always path-style (`<endpoint>/<bucket>/<key>`). Any other path, a query, a
fragment or user info is `CONFIG_INVALID` naming the variable. A bucket's public `r2.dev` URL is
not an endpoint: it is a `public-http` read base (`publicBaseUrl`).

## Profiles

A profile is `{ "kind": "copy" }` or an image profile with at least one of:

| Field    | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resize` | `width` and `height` (required, 1–16384 px), `fit`: `contain` (default, transparent padding) or `inside`. Never upscales.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `webp`   | `lossless` (default `true`), `quality` (1–100, default 80), `alphaQuality` (0–100, default 100), `keepSmaller` (default `true`). With `lossless: true` the pixels are kept exactly and `quality` only trades compression effort for size, which can change the bytes. `keepSmaller: true` (flexible) keeps WebP only when it is smaller than the same-format alternatives (the untouched original when the geometry is kept, the resize in the original's format), otherwise the smallest of those with its real format; `false` (strict) keeps WebP. Any output other than a copy that is larger than its original carries a `SIZE_GREW` notice. |

Profile names are lowercase slugs; `copy` cannot be redefined. Every name used by
`profileRules`, `defaultProfile` or `assets` must exist.

An original's profile is the one its `assets` entry names (pinned in the lock as `profile`), else
that of the first `profileRules` entry whose `match` selects its path (ignoring letter case, like
`sources.include`), else `defaultProfile` ([image policies](../guides/images.md)).

## `limits`

| Field                     | Default             | Meaning                                                                                                                                                                                                  |
| ------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency`             | `4`                 | Parallel transfers and assets in progress, 1–64.                                                                                                                                                         |
| `imageConcurrency`        | `2`                 | Image conversions at once (never more than `concurrency`), 1–16; each holds its original, decoded pixels and output in memory ([resources](../guides/images.md#resources)).                              |
| `maxSourceBytes`          | 536870912 (512 MiB) | Largest accepted original.                                                                                                                                                                               |
| `maxImagePixels`          | 67108864 (8192²)    | Maximum pixels in each conversion's source and planned output, including contain padding; checked before decoding or canvas allocation ([resources](../guides/images.md#resources)).                     |
| `multipartThresholdBytes` | 67108864 (64 MiB)   | Originals of at least this size are uploaded in parts; 5 MiB–5 GiB.                                                                                                                                      |
| `multipartPartBytes`      | 16777216 (16 MiB)   | Size of every part but the last; 5 MiB–5 GiB, and `maxSourceBytes` may need at most 10,000 parts.                                                                                                        |
| `transferAttempts`        | `3`                 | Tries per request for transient failures, including the first; 1–10.                                                                                                                                     |
| `requestTimeoutSeconds`   | `300`               | Deadline for response headers and longest pause between body chunks for downloads and S3 control/error responses; a stall is transient. 1–300; cleanup has its own total budget ([R2](../guides/r2.md)). |

The CLI flag `--concurrency` overrides `limits.concurrency` for one run; for uploads it bounds
the objects in flight, each sending one part at a time.

### Fixed internal bounds

These are not configurable; each keeps one input or one run within a known size or time.

| Bound                                    | Value                                               | What it bounds                                                                      |
| ---------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Config file                              | 1 MiB                                               | A larger config is `CONFIG_INVALID` at `/`, never parsed.                           |
| Lock file                                | 64 MiB                                              | A larger lock is `LOCK_INVALID` at `/`, never parsed.                               |
| Runtime manifest, generation listing     | 64 MiB each                                         | A larger file is not one the tool wrote (unreadable).                               |
| Output marker, cache marker, cache claim | 4 KiB each                                          | A larger marker is foreign; a larger claim counts as live.                          |
| Derivative record                        | 64 KiB                                              | A larger record is not reused; the output is made again.                            |
| Image read for conversion                | 2 GiB − 1 bytes                                     | A larger image original is `IMAGE_TOO_LARGE`; the copy profile never reads it.      |
| Storage error body                       | 16 KiB                                              | Only this much of an error answer is read, for its code.                            |
| Retry backoff                            | a random wait up to 250 ms, doubling to at most 4 s | The pause before each retry of a transient failure (`transferAttempts`).            |
| Multipart abort                          | 30 s                                                | The time an abort of an unfinished upload may take after a failure or cancellation. |
| Multipart parts                          | 10,000                                              | `maxSourceBytes` must fit into this many parts of `multipartPartBytes`.             |
| Cache listing, output audit              | 32 and 16 files at once                             | Parallel file checks while listing the cache or auditing an output tree.            |

## Versioning and migration

`schemaVersion` changes only for incompatible changes. Adding an optional field with a default
that preserves earlier behavior keeps the version. An incompatible change raises it; the tool
rejects versions it does not support with the list it does support, and the migration steps are
documented here. Configs are never rewritten silently.

Version 1 is the first released schema. The unreleased starter draft (top-level `images`, flat
`r2` credential names) is not accepted; run `cratepin init` and move project values over.
