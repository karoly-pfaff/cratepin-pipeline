import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { suite, test } from 'node:test';

import { lockOfOriginals, withBuildFixture } from '../../building/build-fixtures.test-support.ts';
import type { BuildFixture, FixtureOriginal } from '../../building/build-fixtures.test-support.ts';
import type { BuildResult } from '../../building/build-run.ts';
import {
  BUILD_CONFIG,
  buildOf,
  buildOriginals,
  GENERATION_CONFIG,
  snapshotOf,
  withoutFirstAsset,
} from '../../building/build-runs.test-support.ts';
import { originalPathOf } from '../../cache/cache-layout.ts';
import { inventorySources } from '../../catalog/inventory.ts';
import type { InventoryEntry } from '../../catalog/inventory.ts';
import { sha256Of, writeFiles, writeSources } from '../../catalog/source-fixtures.test-support.ts';
import { toPipelineError } from '../../errors.ts';
import type { SourceLock } from '../../lock/source-lock.ts';
import { pngOf, transparentArtwork } from '../../media/testing/media-fixtures.test-support.ts';
import { OUTPUT_MARKER_NAME } from '../../output/ownership/output-marker.ts';
import { verifyFixture } from '../../verify/verify-fixtures.test-support.ts';
import { loadCheckedProject } from './checked-project.ts';
import {
  skipReasonFor,
  snapshotOutside,
  writePublicSentinels,
} from './hostile-layouts.test-support.ts';
import type { VolumeNeed } from './hostile-layouts.test-support.ts';
import { linkDirectory } from './layout-fixtures.test-support.ts';
import { outputWorkDirectoryOf } from './output-work-directory.ts';

/** What a command refused, one `CODE subject` line each; empty when it went through. */
type Refusal = readonly string[];

/**
 * A hostile layout and the command that must refuse it. Every row starts from a published output
 * next to the game's own public files; whatever the command does, nothing outside the cache (the
 * output, the work directory, sources, project files, link targets) may change.
 */
interface HostileRow {
  readonly title: string;
  readonly need?: VolumeNeed;
  readonly config?: object;
  /** Puts the hostile entry in place, after a first build has published the output. */
  readonly arrange: (fixture: BuildFixture) => Promise<void>;
  /** Runs the command against the layout and says what it refused. */
  readonly refusalOf: (fixture: BuildFixture) => Promise<Refusal>;
  readonly refusal: Refusal;
}

function errorLine(error: unknown): string {
  const { code, details } = toPipelineError(error);
  return details.reason === undefined ? code : `${code} ${String(details.reason)}`;
}

function issueLines(issues: readonly { readonly code: string; readonly path: string }[]): Refusal {
  return issues.map(({ code, path }) => `${code} ${path}`);
}

/** Originals a build could not use from its cache; offline they make it stop unpublished. */
function unusableOriginals(result: BuildResult): Refusal {
  const unusable = (result.originals ?? []).filter(({ status }) => status !== 'cached');
  return unusable.map(({ status }) => `ORIGINAL_${status.toUpperCase()}`);
}

function buildResultRefusal(result: BuildResult): Refusal {
  if (result.plan.issues.length > 0) return issueLines(result.plan.issues);
  if (result.failure !== undefined) return [errorLine(result.failure)];
  const unusable = unusableOriginals(result);
  if (unusable.length > 0) return unusable;
  return result.publication === undefined ? ['NOTHING_PUBLISHED'] : [];
}

/** What the config validation and the layout preflight of a fresh command refuse. */
async function configRefusalOf(fixture: BuildFixture): Promise<Refusal> {
  const load = await loadCheckedProject(fixture.project.paths.configFilePath);
  return load.ok ? [] : issueLines(load.issues);
}

/** A fresh build of `lock`, preflight included, as the build command runs it. */
async function buildRefusalOf(fixture: BuildFixture, lock: SourceLock): Promise<Refusal> {
  const load = await loadCheckedProject(fixture.project.paths.configFilePath);
  if (!load.ok) return issueLines(load.issues);
  try {
    return buildResultRefusal(await buildOf({ ...fixture, project: load.project, lock }));
  } catch (error) {
    return [errorLine(error)];
  }
}

/** A build of a lock with one asset fewer, which would publish a new output if it went ahead. */
async function changedBuildRefusalOf(fixture: BuildFixture): Promise<Refusal> {
  return buildRefusalOf(fixture, (await withoutFirstAsset(fixture)).lock);
}

async function scanRefusalOf(fixture: BuildFixture): Promise<Refusal> {
  return issueLines((await inventorySources(fixture.project)).issues);
}

function workDirectoryOf(fixture: BuildFixture): string {
  return outputWorkDirectoryOf(fixture.project.paths.outputRoot);
}

function elsewhereOf(fixture: BuildFixture): string {
  return join(fixture.workspace, 'elsewhere');
}

async function rewriteConfig(fixture: BuildFixture, changes: object): Promise<void> {
  const configFile = fixture.project.paths.configFilePath;
  const config = JSON.parse(await readFile(configFile, 'utf8')) as object;
  await writeFile(configFile, JSON.stringify({ ...config, ...changes }));
}

/** An author's files where builds stage and trash, as a source directory there would hold. */
async function writeAuthorFilesInWork(fixture: BuildFixture): Promise<void> {
  await writeFiles(workDirectoryOf(fixture), {
    'staging/mine.png': 'an author file',
    'trash/c/notes.txt': 'author notes',
  });
}

const WORK = 'public/.assets.cratepin';

/** A config field placed where the build keeps its work, refused before any build runs. */
function workDirectoryConfigRow(row: {
  readonly title: string;
  readonly changes: Readonly<Record<string, string>>;
  readonly config?: object;
}): HostileRow {
  const [field = ''] = Object.keys(row.changes);
  return {
    title: row.title,
    ...(row.config === undefined ? {} : { config: row.config }),
    arrange: async (fixture) => {
      await writeAuthorFilesInWork(fixture);
      await rewriteConfig(fixture, row.changes);
    },
    refusalOf: configRefusalOf,
    refusal: [`CONFIG_INVALID /${field}`],
  };
}

const WORK_DIRECTORY_CONFIG_ROWS: readonly HostileRow[] = [
  { title: 'a source directory that is the work directory', changes: { sourceDir: WORK } },
  { title: 'a source directory in the staging', changes: { sourceDir: `${WORK}/staging` } },
  {
    title: 'a source directory in a case variant of the work directory',
    changes: { sourceDir: 'public/.ASSETS.cratepin' },
  },
  { title: 'a cache in the trash', changes: { cacheDir: `${WORK}/trash/c` } },
  { title: 'a lock in the work directory', changes: { lockFile: `${WORK}/cratepin-lock.json` } },
  {
    title: 'a source directory in the work directory in generation mode',
    changes: { sourceDir: WORK },
    config: GENERATION_CONFIG,
  },
].map(workDirectoryConfigRow);

const LINKED_WORK_DIRECTORY_ROW: HostileRow = {
  title: 'a source directory reached through a junction into the work directory',
  arrange: async (fixture) => {
    await writeAuthorFilesInWork(fixture);
    await linkDirectory(workDirectoryOf(fixture), join(fixture.workspace, 'linked'));
    await rewriteConfig(fixture, { sourceDir: 'linked/staging' });
  },
  refusalOf: configRefusalOf,
  refusal: ['CONFIG_INVALID /sourceDir'],
};

const OUTPUT_MODES = [
  { mode: 'path-preserving', config: BUILD_CONFIG },
  { mode: 'generation', config: GENERATION_CONFIG },
];

/** The marker, the file listing and the runtime manifest, as written and in other letter cases. */
const TOOL_FILE_SOURCES = [
  '.cratepin-output.json',
  '.Cratepin-Output.JSON',
  '.cratepin-generation.json',
  '.CRATEPIN-GENERATION.json',
  'cratepin-manifest.json',
  'Cratepin-Manifest.json',
];

async function lockWithSource(source: string): Promise<SourceLock> {
  const reserved: FixtureOriginal = { source, bytes: Buffer.from('{}'), category: 'other' };
  return lockOfOriginals([...(await buildOriginals()), reserved]);
}

const RESERVED_SOURCE_ROWS: readonly HostileRow[] = OUTPUT_MODES.flatMap(({ mode, config }) =>
  TOOL_FILE_SOURCES.map((source) => ({
    title: `a lock source named ${source} in ${mode} mode`,
    config,
    arrange: () => Promise.resolve(),
    refusalOf: async (fixture: BuildFixture) =>
      buildRefusalOf(fixture, await lockWithSource(source)),
    refusal: [`OUTPUT_PATH_RESERVED ${source}`],
  })),
);

/** A junction at `linkPath` to a directory outside every root that a build must never empty. */
async function linkElsewhere(fixture: BuildFixture, linkPath: string): Promise<void> {
  await writeFiles(elsewhereOf(fixture), {
    'keep.png': 'kept elsewhere',
    'staging/old.webp': 'looks like a staged output',
  });
  await linkDirectory(elsewhereOf(fixture), linkPath);
}

const JUNCTION_ROWS: readonly HostileRow[] = [
  ...OUTPUT_MODES.map(({ mode, config }) => ({
    title: `a junction at the work directory in ${mode} mode`,
    config,
    arrange: (fixture: BuildFixture) => linkElsewhere(fixture, workDirectoryOf(fixture)),
    refusalOf: changedBuildRefusalOf,
    refusal: ['OUTPUT_CONFLICT WORK_DIRECTORY_NOT_A_DIRECTORY'],
  })),
  ...[
    { name: 'backup', refusal: ['OUTPUT_CONFLICT INTERRUPTED_SWAP_UNCLEAR'] },
    { name: 'staging', refusal: ['OUTPUT_CONFLICT'] },
    { name: 'trash', refusal: ['OUTPUT_CONFLICT INTERRUPTED_SWAP_UNCLEAR'] },
    { name: 'claims', refusal: ['OUTPUT_CONFLICT WORK_DIRECTORY_NOT_A_DIRECTORY'] },
  ].map(({ name, refusal }) => ({
    title: `a junction at the ${name} in the work directory`,
    arrange: async (fixture: BuildFixture) => {
      await mkdir(workDirectoryOf(fixture));
      await linkElsewhere(fixture, join(workDirectoryOf(fixture), name));
    },
    refusalOf: changedBuildRefusalOf,
    refusal,
  })),
];

/** Replaces `path` with a file symlink to a copy of it outside every root. */
async function replaceWithFileLink(fixture: BuildFixture, path: string): Promise<void> {
  const target = join(elsewhereOf(fixture), 'linked-copy');
  await mkdir(elsewhereOf(fixture), { recursive: true });
  await copyFile(path, target);
  await rm(path);
  await symlink(target, path, 'file');
}

/** Writes the fixture's originals as its sources, plus `extra`, so every include pattern matches. */
async function writeOriginalSources(
  fixture: BuildFixture,
  extra: Readonly<Record<string, Uint8Array>> = {},
): Promise<void> {
  const originals = await buildOriginals();
  const files = Object.fromEntries(originals.map(({ source, bytes }) => [source, bytes]));
  await writeSources(fixture.workspace, { ...files, ...extra });
}

/** Writes the sources, plus a file symlink at `app/ui/linked.png` to `target`. */
async function linkSource(fixture: BuildFixture, target: string): Promise<void> {
  await writeOriginalSources(fixture);
  await symlink(target, join(fixture.project.paths.sourceRoot, 'app', 'ui', 'linked.png'), 'file');
}

async function firstCacheEntryOf(fixture: BuildFixture): Promise<string> {
  const [first] = await buildOriginals();
  if (first === undefined) throw new Error('No original to link');
  return originalPathOf(fixture.layout, sha256Of(first.bytes));
}

/** Rows that put a file symbolic link in place, which only volumes allowing them can run. */
const LINKED_FILE_ROWS: readonly HostileRow[] = [
  {
    title: 'a source file that is a symbolic link',
    arrange: async (fixture) => {
      await writeFiles(elsewhereOf(fixture), { 'secret.png': 'outside the sources' });
      await linkSource(fixture, join(elsewhereOf(fixture), 'secret.png'));
    },
    refusalOf: scanRefusalOf,
    refusal: ['NOT_A_REGULAR_FILE app/ui/linked.png'],
  },
  {
    title: 'a dangling symbolic link among the sources',
    arrange: (fixture) => linkSource(fixture, join(elsewhereOf(fixture), 'gone.png')),
    refusalOf: scanRefusalOf,
    refusal: ['NOT_A_REGULAR_FILE app/ui/linked.png'],
  },
  {
    title: 'a cache entry that is a symbolic link to the right bytes',
    arrange: async (fixture) => replaceWithFileLink(fixture, await firstCacheEntryOf(fixture)),
    refusalOf: (fixture) => buildRefusalOf(fixture, fixture.lock),
    refusal: ['ORIGINAL_MISSING'],
  },
  {
    title: 'a lock file that is a symbolic link',
    arrange: async (fixture) => {
      await writeFile(fixture.project.paths.lockFilePath, '{}');
      await replaceWithFileLink(fixture, fixture.project.paths.lockFilePath);
    },
    refusalOf: configRefusalOf,
    refusal: ['CONFIG_INVALID /lockFile'],
  },
  {
    title: 'a config file that is a symbolic link',
    arrange: (fixture) => replaceWithFileLink(fixture, fixture.project.paths.configFilePath),
    refusalOf: configRefusalOf,
    refusal: ['CONFIG_INVALID /'],
  },
  {
    title: 'a published output file that is a symbolic link to its own bytes',
    arrange: (fixture) =>
      replaceWithFileLink(fixture, join(fixture.project.paths.outputRoot, 'voice/hu/hello.mp3')),
    refusalOf: changedBuildRefusalOf,
    refusal: ['OUTPUT_CONFLICT UNLISTED_OUTPUT_ENTRY'],
  },
  {
    title: 'an output marker that is a symbolic link to its own text',
    arrange: (fixture) =>
      replaceWithFileLink(fixture, join(fixture.project.paths.outputRoot, OUTPUT_MARKER_NAME)),
    refusalOf: changedBuildRefusalOf,
    refusal: ['OUTPUT_CONFLICT OUTPUT_MARKER_INVALID'],
  },
];

const FILE_SYMLINK_ROWS: readonly HostileRow[] = LINKED_FILE_ROWS.map((row) => ({
  ...row,
  need: 'file-symlinks',
}));

async function twinOriginals(): Promise<FixtureOriginal[]> {
  return [
    { source: 'ui/Hero.png', bytes: await pngOf(transparentArtwork(5, 3)), profile: 'ui-strict' },
    { source: 'ui/hero.png', bytes: await pngOf(transparentArtwork(7, 5)), profile: 'ui-strict' },
  ];
}

const CASE_TWIN_ROWS: readonly HostileRow[] = [
  {
    title: 'sources Hero.png and hero.png side by side on disk',
    need: 'case-twins',
    arrange: async (fixture) => {
      const twins = await twinOriginals();
      await writeOriginalSources(
        fixture,
        Object.fromEntries(twins.map(({ source, bytes }) => [source, bytes])),
      );
    },
    refusalOf: scanRefusalOf,
    refusal: ['CASE_COLLISION ui/Hero.png', 'CASE_COLLISION ui/hero.png'],
  },
  {
    title: 'lock sources Hero.png and hero.png',
    arrange: () => Promise.resolve(),
    refusalOf: async (fixture) => buildRefusalOf(fixture, lockOfOriginals(await twinOriginals())),
    refusal: ['OUTPUT_PATH_COLLISION ui/hero.webp'],
  },
];

const HOSTILE_ROWS: readonly HostileRow[] = [
  ...WORK_DIRECTORY_CONFIG_ROWS,
  LINKED_WORK_DIRECTORY_ROW,
  ...RESERVED_SOURCE_ROWS,
  ...JUNCTION_ROWS,
  ...FILE_SYMLINK_ROWS,
  ...CASE_TWIN_ROWS,
];

const SKIP_REASONS = new Map<VolumeNeed, string | undefined>([
  ['file-symlinks', await skipReasonFor('file-symlinks')],
  ['case-twins', await skipReasonFor('case-twins')],
]);

function skipOf({ need }: HostileRow): string | false {
  return need === undefined ? false : (SKIP_REASONS.get(need) ?? false);
}

async function assertRefusedWithWorkspaceKept(row: HostileRow): Promise<void> {
  await withBuildFixture(await buildOriginals(), row.config ?? BUILD_CONFIG, async (fixture) => {
    await writePublicSentinels(fixture.workspace);
    assert.deepEqual(buildResultRefusal(await buildOf(fixture)), [], 'a first build publishes');
    await row.arrange(fixture);
    const ownedRoots = [fixture.project.paths.cacheRoot];
    const before = await snapshotOutside(fixture.workspace, ownedRoots);
    assert.ok('public/index.html' in before && 'public/other/keep.txt' in before);
    assert.deepEqual(await row.refusalOf(fixture), row.refusal);
    assert.deepEqual(await snapshotOutside(fixture.workspace, ownedRoots), before);
  });
}

suite(
  'a hostile layout is refused and nothing outside the cache changes',
  { concurrency: true },
  () => {
    for (const row of HOSTILE_ROWS) {
      test(row.title, { skip: skipOf(row) }, () => assertRefusedWithWorkspaceKept(row));
    }
  },
);

function scannedHashesOf(entries: readonly InventoryEntry[]): string[] {
  return entries.map(({ path, sha256 }) => `${path} ${sha256}`);
}

function lockedHashesOf(originals: readonly FixtureOriginal[]): string[] {
  return originals.map(({ source, bytes }) => `${source} ${sha256Of(bytes)}`);
}

/**
 * Four nested directories of 61 characters each and a file name: 258 characters, so the path
 * on disk, below the source root, is well over 260.
 */
const LONG_SOURCE = `${Array.from(
  { length: 4 },
  (_, level) => `level-${String(level)}-${'nested-folder'.repeat(4)}-`,
).join('/')}/button.png`;

test('a source whose path on disk is over 260 characters is scanned, built, verified and removed inside the roots', async () => {
  const [, voice] = await buildOriginals();
  if (voice === undefined) throw new Error('No voice original');
  const long = {
    source: LONG_SOURCE,
    bytes: await pngOf(transparentArtwork(9, 9)),
    profile: 'ui-strict',
  };
  await withBuildFixture([long, voice], BUILD_CONFIG, async (fixture) => {
    const { sourceRoot, cacheRoot, outputRoot } = fixture.project.paths;
    await writePublicSentinels(fixture.workspace);
    await writeSources(fixture.workspace, {
      [LONG_SOURCE]: long.bytes,
      [voice.source]: voice.bytes,
    });
    assert.ok(join(sourceRoot, LONG_SOURCE).length > 260, 'the source path is long');
    const before = await snapshotOutside(fixture.workspace, [cacheRoot, outputRoot]);
    const scanned = await inventorySources(fixture.project);
    assert.deepEqual(scanned.issues, []);
    assert.deepEqual(scannedHashesOf(scanned.entries), lockedHashesOf([long, voice]));
    assert.equal((await buildOf(fixture)).publication?.outcome, 'published');
    const longOutput = LONG_SOURCE.replace(/\.png$/u, '.webp');
    assert.ok(longOutput in (await snapshotOf(outputRoot)), 'the long output is published');
    assert.deepEqual((await verifyFixture(fixture)).issues, []);
    const withoutLong = { ...fixture, lock: lockOfOriginals([voice]) };
    const replaced = await buildOf(withoutLong);
    assert.ok((replaced.publication?.removedFileCount ?? 0) > 0, 'the old root was removed');
    assert.ok(!(longOutput in (await snapshotOf(outputRoot))));
    assert.deepEqual((await verifyFixture(withoutLong)).issues, []);
    assert.deepEqual(await readdir(join(fixture.workspace, 'public')), [
      'assets',
      'index.html',
      'other',
    ]);
    assert.deepEqual(await snapshotOutside(fixture.workspace, [cacheRoot, outputRoot]), before);
  });
});
