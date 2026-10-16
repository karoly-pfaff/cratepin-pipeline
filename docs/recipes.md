# Checked CLI and public API recipes

Use Node 24 and pin Cratepin as a development dependency. Release packages use GitHub Packages.
Add `@karoly-pfaff:registry=https://npm.pkg.github.com/` to the consumer's `.npmrc` and
[authenticate to GitHub Packages](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages)
with package read access. Keep credentials in your user configuration or CI secrets, outside Git.
From a clean ESM consumer directory whose `package.json` declares `"type": "module"`, install
the beta with `npm install --save-dev --save-exact --ignore-scripts @karoly-pfaff/cratepin@1.0.0-beta.1`.

Alternatively, install a local checked tarball with
`npm install --save-dev --ignore-scripts /path/to/karoly-pfaff-cratepin-<version>.tgz`.
Commit that dependency lock. For an offline install, the tarball and its platform-specific Sharp
dependencies must already be available in npm's cache; `--offline` never means dependency-free.

The external `npm run check:package` test installs the actual tarball, compiles the exact
TypeScript fences below and runs their emitted JavaScript. It executes every CLI fence under
the network-block preload with no credential variables. The fixture is a tiny local SVG, not
a production application or live R2 proof. [The Vite example](../examples/vite-consumer/README.md) demonstrates project integration.

## Inspect before writing

Run in the consumer root, with originals below `assets/source/` and an existing `public/`
directory owned by the host project. The tool creates its output child, never a missing output
parent. `init` refuses to replace an
existing configuration. `push --dry-run` previews a lock; it never uploads or commits that lock.
`npm exec --offline --no-update-notifier --` resolves the locally installed CLI without a global
installation and disables npm's independent background update check.

```sh recipe=inspect
npm exec --offline --no-update-notifier -- cratepin init --json
npm exec --offline --no-update-notifier -- cratepin validate --json
npm exec --offline --no-update-notifier -- cratepin hash assets/source/ui/icon.svg --json
npm exec --offline --no-update-notifier -- cratepin scan --json
npm exec --offline --no-update-notifier -- cratepin push --dry-run --json
```

For real authoring, use an explicitly configured writer and `push` only after reviewing the
preview. That author action is not an install/build hook. CI needs only read access on a cache
miss; warm offline builds need none. See [credentials](guides/r2.md) and
[consumer CI](integration.md#ci). Secrets stay outside config, Git and runtime output.

## Public API: preview a source lock

Save this as `preview.ts`. All library imports come from `@karoly-pfaff/cratepin`; internal module paths
are unsupported and rejected by the package export map. Paths resolve relative to the config.
The API exposes typed building blocks; use the CLI for build publication, verify and doctor
orchestration. A preview is not a committed lock and proves no remote object exists.

```ts recipe=preview
import {
  catalogSources,
  inventorySources,
  loadCheckedProject,
  stageLock,
  type CheckedProject,
  type SourceLock,
} from '@karoly-pfaff/cratepin';

export async function checkedProjectFrom(configFile: string): Promise<CheckedProject> {
  const load = await loadCheckedProject(configFile);
  if (!load.ok) throw new Error('Invalid configuration or layout; inspect load.issues.');
  return load.project;
}

export async function previewSourceLock(configFile: string): Promise<SourceLock> {
  const project = await checkedProjectFrom(configFile);
  const inventory = await inventorySources(project);
  const catalog = catalogSources(inventory, project.config.assets);
  return stageLock(project.config, catalog);
}
```

## Local-only author/cache trial

Save as `memory.ts` beside `preview.ts`. Compile both with strict TypeScript, NodeNext modules
and an ES2022 target. `./preview.js` is your emitted example module, not a tool deep import.
Call `seedMemoryTrial('cratepin.config.json')` in a disposable consumer root after the
inspect recipe, and check the returned original outcomes: only `cached` and `downloaded` mean
that an original is available; other statuses report per-object failure. It explicitly creates a verified lock and fills the cache, using an ephemeral
in-memory store. It does not write to R2. The memory store disappears when the process ends;
it is not a backup or a production remote. Existing projects should use the authoring CLI
and their configured storage, not replace a real lock with this trial.

```ts recipe=memory
import {
  createMemoryStore,
  pullLockedOriginals,
  pushStagedLock,
  type PullResult,
} from '@karoly-pfaff/cratepin';
import { checkedProjectFrom, previewSourceLock } from './preview.js';

export async function seedMemoryTrial(configFile: string): Promise<PullResult> {
  const project = await checkedProjectFrom(configFile);
  const store = createMemoryStore();
  const staged = await previewSourceLock(configFile);
  const pushed = await pushStagedLock({
    project,
    staged,
    committed: undefined,
    concurrency: 1,
    storage: { writer: store, reader: store },
  });
  if (!pushed.ok) throw pushed.error;
  return pullLockedOriginals({
    project,
    lock: pushed.lock,
    concurrency: 1,
    isOffline: false,
    isRestoringSources: false,
    openReader: () => store,
  });
}
```

## Build from that verified cache

These commands require the local trial above or originals previously retrieved from real
storage. An empty cache with a valid nonempty lock fails offline with `NOT_FOUND` (exit 10)
and exact `CACHE_MISS` IDs/hashes; local source files never stand in for missing cache entries.

```sh recipe=build
npm exec --offline --no-update-notifier -- cratepin pull --offline --json
npm exec --offline --no-update-notifier -- cratepin build --offline --dry-run --json
npm exec --offline --no-update-notifier -- cratepin build --offline --json
npm exec --offline --no-update-notifier -- cratepin verify --json
npm exec --offline --no-update-notifier -- cratepin doctor --offline --json
npm exec --offline --no-update-notifier -- cratepin cache prune --dry-run --json
```

`verify` reads only and needs no `--offline` flag; passing unsupported flags is `USAGE`, not
an ignored option. `cache prune` only removes unreferenced local entries, never remote originals.
Expected failure after the earlier init, preserving the existing config (exit 9):

```sh recipe=conflict
npm exec --offline --no-update-notifier -- cratepin init --json
```

The only planned command below is unavailable; it parses its flags then returns
`NOT_IMPLEMENTED` (exit 3) without reading or writing anything:

```sh recipe=planned
npm exec --offline --no-update-notifier -- cratepin remote gc --json
```

## Contracts and migration

The [CLI table](contracts/cli.md) lists all implemented commands and accepted flags.
The [error contract](contracts/errors.md) defines stable error and exit codes; the
[report contract](contracts/reports.md) defines rendered outcomes and redaction. The
[CLI contract](contracts/cli.md) covers output routing and cancellation. Config, source lock and runtime manifest each
currently use schema version 1; see [configuration](contracts/config.md),
[source lock](contracts/data.md#source-lock) and [runtime manifest](contracts/data.md#generated-runtime-manifest).
The hash placeholders in schematic JSON are explanatory, not valid lock/manifest fixtures.

To migrate the unsupported unreleased config draft (`images`, flat R2 names), preserve the old
file and generate a separate version-1 config with `init --config cratepin.v1.json`.
Transfer project paths, profiles and environment-name references deliberately, then validate and
review scan/dry-run results before any author push. Preserve released locks and originals.
There is no automatic lock/manifest schema upgrader: unsupported versions fail explicitly;
rebuild generated output with the compatible pinned tool rather than hand-editing manifests.

The [Vite example](../examples/vite-consumer/README.md) demonstrates lifecycle hooks and URL resolution. Its CI template is provided for consumers to copy; it does not run a deployment from this repository.
