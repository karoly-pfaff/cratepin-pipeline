# Integrating Cratepin

Cratepin prepares pinned media for websites, applications, documentation sites and other projects
that publish static assets. It runs during development and builds; the resulting files work
independently of Cratepin, R2 and the framework used by the consuming project.

Install a pinned tool release/tarball as a development dependency, following the
[installation recipes](recipes.md). Commit `cratepin.config.json`, `cratepin-lock.json`, media
policy inputs and the project's dependency lock. Ignore originals, cache and generated output.
Keep package scripts explicit; do not retrieve assets during dependency installation.

## Consumer scripts

Add asset commands to the project's existing scripts. With npm, `prebuild` runs before an
existing `build` script; keep that build command for your framework or packaging tool.

```json
{
  "scripts": {
    "assets:scan": "cratepin scan",
    "assets:push": "cratepin push",
    "assets:build": "cratepin build && cratepin verify",
    "assets:build:offline": "cratepin build --offline && cratepin verify",
    "prebuild": "npm run assets:build"
  }
}
```

`scan` and `push` are author actions run by hand. Installing the tool runs none of its code, and
`build` only reads storage, so neither `npm install` nor `npm run build` uploads anything. `build`
gets the pinned originals itself; run `pull` to fill the cache ahead of an offline build, or
`pull --restore-sources` to bring back missing originals before authoring.

The [Vite consumer example](../examples/vite-consumer/README.md) demonstrates one integration:
a development dependency, asset preparation before bundling, and a page that loads media by
logical ID. Other build systems can invoke the same CLI commands in their own lifecycle.

## Runtime paths and media policies

Each project has its own project ID, storage namespace, lock, logical IDs and media policies.
Configure output paths to match the application's existing asset layout. The generated manifest
maps logical IDs to actual output filenames, including any deliberate format changes.

Resolve relative URLs against the application's public base URL. A leading `/` would break
relative deployments, including Vite `base: './'` and packaged webviews. The example's
[assetUrls.js](../examples/vite-consumer/src/assetUrls.js) provides a lookup you can adapt.

The runtime manifest is served at `<base><outputUrlPath>/cratepin-manifest.json`; fetch it at runtime (bundlers do not import from `public/`) and resolve each entry's `url` against the base. In Vite, for example, use `new URL(entry.url, new URL(import.meta.env.BASE_URL, document.baseURI))`. With a relative base the page must be served from the directory that holds `index.html` (a URL ending in `/` or naming the file); without the slash, or at a deep route served by a history-routing fallback, `./` points elsewhere. History-routed hosts need an absolute base, which ties that build to its one path. Existing `.png` string paths keep working in the default path-preserving output mode as long as the asset's profile keeps its format. When a profile changes format, add a deliberate manifest resolver or content adapter for that asset. Never change extensions and leave stale references, or silently edit content files. Validate media references after asset preparation and before bundling. Include the generated files in the final application or site output.

Keep screen derivatives separate from print masters. A print build retrieves full-quality pinned originals/profile; it must not use web-resized files in PDFs automatically. Voice/effects/music are byte-preserving copies.

## CI

The [CI template](../examples/vite-consumer/ci/game-build.yml) of the Vite example shows the
split for GitHub Actions; the rules hold for any CI:

GitHub Packages dependency installation also needs authentication, including for public npm
packages. The template configures the scoped registry and `packages: read`, and gives only
the install step its automatic `github.token`. This is distinct from R2 credentials and from
a PAT: forks receive no repository secrets. Use a public package or explicitly grant the
consumer repository workflow access; otherwise provide a checked local tarball in the checkout.

- Only `build`, `pull` and `verify` run in CI; `scan` and `push` are author actions. Writer keys
  never enter CI, and the tool resolves the read pair only on a cache miss.
- Give CI its own token, scoped to the bucket and to reading objects. The tool can only check
  that the read and writer variables have different names; a token with write permission stored
  under the read names can write. With a read-only token, storage refuses any write as
  `AUTH_FAILED`.
- Only trusted jobs (pushes to the repository and pull requests from its own branches) get the
  read pair. A pull request from a fork runs its own code, which sees every secret its job gets,
  and it can change the workflow, the job conditions and the config's variable names: it must get
  no secret at all. On GitHub the platform withholds secrets from a fork's `pull_request` run (in
  a private repository keep "Send secrets to workflows from fork pull requests" off); deployment
  branch rules cannot tell a fork's pull request from one of the repository's own. Never use
  triggers that hand secrets to pull request code (`pull_request_target`, or a `workflow_run`
  that checks it out).
- With the default `s3-readonly` transport a fork's build on a cold cache stops with
  `CONFIG_INVALID` (exit 2), naming only the read variables, before any request. Restore the
  cache a trusted job saved and build with `--offline`: no request and no credential. An
  original the cache lacks (one the pull request added) fails it with `NOT_FOUND` (exit 10) and a
  `CACHE_MISS` issue naming that original; it gets into that cache only once an author has pushed
  it and the updated lock is on the default branch, whose trusted build then caches it. With
  `public-http`, any checkout, forks included, reads the pinned originals without a secret;
  choose it only when the originals are not confidential.
- Cache `.cratepin-cache/cratepin-cache.json`, `originals/` and `derivatives/`, never `claims/`,
  `incoming/` or `quarantine/` (a claim of another machine counts as live). A restored original
  is used only when its bytes match the locked hash, so an older cache cannot change it. A
  derivative is checked only against its own cached record, which the lock does not pin: a cache
  that an untrusted job could write can change a trusted build's output. Let trusted builds
  restore only caches trusted jobs saved (on GitHub a fork's pull request saves into its own
  scope, and the template's fork job only restores); on CI with caches shared across branches or
  persistent runners, keep untrusted jobs off the trusted cache.
- Reports name variables, IDs, hashes and paths, never a variable's value: a cache miss or a
  rejected key with secrets set shows none of them.

## Deployment and offline runtime

Run asset preparation before bundling, static-site generation or application packaging, and
include the generated public files in the deployable output. With Capacitor, for example, build
and verify assets before the web build and `cap sync`.

Generated media needs no R2 credentials or storage connection at runtime. Offline availability
depends on how the application delivers those files: a packaged application can include them,
while a website needs its own browser caching or installation strategy. Validate base paths,
localized media and rendering in the environments the application supports.

## Adopting an existing output directory

A build never takes over a non-empty directory without `.cratepin-output.json`
(`OUTPUT_NOT_OWNED`), not even one holding only a `.gitkeep`. To move an existing, hand-maintained
`public/assets` to the tool: move the directory aside (for example to `public/assets.legacy`, or
outside `public/`), build, run `verify`, compare the new output with the old copy, then delete the old copy
deliberately. Tool support for this migration is planned later.

The build owns the whole output directory: anything put into it by hand (also `Thumbs.db` or an
empty directory) makes the next build stop with `UNLISTED_OUTPUT_ENTRY` instead of discarding it.
While it publishes, a build keeps its staging and the previous output in a hidden sibling, for
example `public/.assets.cratepin/`, and removes it when done. Ignore both in Git:

```gitignore
public/assets/
public/.assets.cratepin/
```

On Windows a dev server, an editor, Explorer or a terminal with a file or its working directory
inside the output can keep it from being replaced; the build then stops with `OUTPUT_IN_USE`,
leaving the previous output, and succeeds once it is closed.

The work directory sits inside `public/`, which hosts such as Vite copy into the bundle. A build
that ends normally leaves none of it, but a crashed build or a kept file (`OUTPUT_TRASH_KEPT`,
`BACKUP_KEPT`) can leave an old output there until the next build removes it; run the asset build
before the web build (as `prebuild` above does), and treat those notices as a reason to check
`public/` before a release.

## Replacing an existing asset script

When a project already prepares its media with its own script, keep its script names
(`assets:prepare`, `runtime:prepare`, …) so callers keep working, and point their bodies at the
tool. Before the switch:

- Remove the old script's clean or prepare commands rather than leaving them wired: a clean that
  deletes the output directory, or a prepare that writes into it, now hits a directory the tool
  owns (`UNLISTED_OUTPUT_ENTRY` on the next build, or the whole output gone).
- Tests or checks that list the generated directory must allow the tool's files at its top: in
  path-preserving mode `cratepin-manifest.json`, `.cratepin-output.json` and
  `.cratepin-generation.json`; in generation mode the marker, the manifest and
  `generations/` (each generation holding its own listing).
- CI that used to restore originals from a public URL now runs the tool's read transport: with
  `s3-readonly` every job that restores or builds on a cold cache needs `R2_ENDPOINT`,
  `R2_BUCKET` and the read-only pair as secrets (trusted contexts only, see [CI](#ci)), or a
  restored verified cache; with `public-http` it needs none.
- Two originals whose names differ only by extension (`butterfly.gif` and `butterfly.png`) would
  get one ID and stop `scan` with `DUPLICATE_ID`; give one of them an explicit `id` in `assets`.
- The tool never upscales: an image smaller than its profile's resize box keeps its size (with
  `fit: contain` it is padded to the box, so it shows smaller inside it). If the old script
  enlarged small placeholders, assign them `copy`: a host box styled with `object-fit: contain`
  then scales the copy up as it scaled the enlarged file.
- Compare the first output with the old one before relying on it: the same paths, copies byte
  for byte, resized images with the same dimensions.

## Migrating Git-stored media

Inventory original bytes/IDs/licenses, stage R2 uploads and verify, commit config/lock/integration, prove clean-checkout build and rollback. Only then deliberately untrack originals/ignore outputs. Do not erase local masters or rewrite Git history as an automatic sync effect. Keep versioned lock references needed by released application or site versions before any remote retention cleanup.

## Generation mode

With `outputMode: "generation"` every build that changes an output writes a new directory
`public/assets/generations/<16 hex>/` and then switches `public/assets/cratepin-manifest.json` to it
in one step; URLs in the manifest point into the generation, so a host or service worker can cache
them for good and use `generation` as its cache version. The previous generation stays until the
next switch, so a page that loaded the old manifest keeps working. The root itself never moves:
an open file inside it does not stop a build, only a manifest held open does (`OUTPUT_IN_USE`,
the old manifest stays). Entries put into the root by hand are kept and reported
(`UNKNOWN_OUTPUT_NAME`), never served. Ignore `public/assets/` in Git as above.

## Before packaging

Run `cratepin verify` after asset preparation and before bundling or packaging. It reads
the published output only and fails (exit 7, 8 or 9) when anything there is missing, changed,
stale against the committed lock (provenance, IDs) or against the paths and copy rules of the
current profiles, unsafe to ship (an absolute path, a storage address, a signed URL) or left by an
interrupted build, so a broken or stale output never reaches the distributable. It does not
re-encode: after changing a profile's quality or resize box, build again. A typical script is `"prebuild": "cratepin build && cratepin verify"`.
