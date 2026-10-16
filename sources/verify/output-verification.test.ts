import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  failsBecause,
  lockOfOriginals,
  withBuildFixture,
} from '../building/build-fixtures.test-support.ts';
import type { BuildFixture, FixtureOriginal } from '../building/build-fixtures.test-support.ts';
import {
  BUILD_CONFIG,
  buildOf,
  buildOriginals,
  GENERATION_CONFIG,
} from '../building/build-runs.test-support.ts';
import { checkedProjectIn } from '../catalog/source-fixtures.test-support.ts';
import { pngOf, transparentArtwork } from '../media/testing/media-fixtures.test-support.ts';
import { generationLayoutOf } from '../output/generation/generation-layout.ts';
import { generationNameOf } from '../output/generation/generation-listing.ts';
import { RUNTIME_MANIFEST_NAME } from '../output/layout/output-paths.ts';
import { manifestTextOf } from '../output/manifest/runtime-manifest.ts';
import type { ManifestEntry } from '../output/manifest/runtime-manifest.ts';
import { workDirectoryOf } from '../output/layout/work-directory.ts';
import { linkDirectory } from '../paths/layout/layout-fixtures.test-support.ts';
import { parsePublishedManifest } from './published-manifest.ts';
import type { ParsedManifest } from './published-manifest.ts';
import {
  issueCodesOf,
  issuesWithCode,
  republish,
  rewriteManifest,
  verifyFixture,
} from './verify-fixtures.test-support.ts';

async function publishedFixture(
  originals: readonly FixtureOriginal[],
  config: object,
  useFixture: (fixture: BuildFixture) => Promise<void>,
): Promise<void> {
  await withBuildFixture(originals, config, async (fixture) => {
    const result = await buildOf(fixture);
    assert.equal(result.publication?.outcome, 'published');
    await useFixture(fixture);
  });
}

/** The entries with the one of `id` pointing at `url`. */
function withUrl(entries: readonly ManifestEntry[], id: string, url: string): ManifestEntry[] {
  return entries.map((entry) =>
    entry.id === id ? { ...entry, asset: { ...entry.asset, url } } : entry,
  );
}

function rootOf(fixture: BuildFixture): string {
  return fixture.project.paths.outputRoot;
}

test('a fresh build verifies clean, with what was checked', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    const verification = await verifyFixture(fixture);
    assert.deepEqual(verification.issues, []);
    assert.equal(verification.assetCount, 2);
    assert.equal(verification.fileCount, 2);
    assert.ok(verification.byteCount > 0);
  });
});

test('missing, changed and extra files are found', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await rm(join(rootOf(fixture), 'voice', 'hu', 'hello.mp3'));
    await writeFile(join(rootOf(fixture), 'app', 'ui', 'button.webp'), 'changed');
    await writeFile(join(rootOf(fixture), 'notes.txt'), 'mine');
    assert.deepEqual(issueCodesOf(await verifyFixture(fixture)), [
      'OUTPUT_MISMATCH',
      'OUTPUT_MISSING',
      'UNLISTED_OUTPUT_ENTRY',
    ]);
  });
});

test('a manifest that is not exactly what the tool writes is invalid', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    const manifestFile = join(rootOf(fixture), RUNTIME_MANIFEST_NAME);
    const text = await readFile(manifestFile, 'utf8');
    const edits = [
      text.slice(0, -20),
      text.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "extra": true,'),
      text.replace('  "assets"', '  "projectId": "demo",\n  "assets"'),
      text.replaceAll('\n', '\r\n'),
    ];
    for (const edited of edits) {
      await writeFile(manifestFile, edited);
      assert.deepEqual(issueCodesOf(await verifyFixture(fixture)), ['MANIFEST_INVALID']);
    }
  });
});

test('a canonical manifest holding a value that must not ship is flagged', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    const manifestFile = join(rootOf(fixture), RUNTIME_MANIFEST_NAME);
    const text = await readFile(manifestFile, 'utf8');
    const manifest = parsePublishedManifest(JSON.parse(text), text);
    assert.ok(manifest !== undefined);
    const unsafeUrls = [
      'https://cdn.example/x.mp3',
      '../x.mp3',
      'assets/x.mp3?X-Amz-Signature=1',
      fixture.project.paths.cacheRoot,
    ];
    for (const url of unsafeUrls) {
      const entries = withUrl(manifest.entries, 'voice/hu/hello', url);
      await writeFile(manifestFile, manifestTextOf(manifest.header, entries));
      assert.ok(issueCodesOf(await verifyFixture(fixture)).includes('MANIFEST_UNSAFE_VALUE'), url);
    }
  });
});

test('a profile change since the build makes the published output stale', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    const copying = { profiles: { 'ui-strict': { kind: 'copy' } } };
    const project = await checkedProjectIn(fixture.workspace, copying);
    const verification = await verifyFixture({ ...fixture, project });
    assert.deepEqual(issueCodesOf(verification), ['MANIFEST_STALE']);
  });
});

test('a lock that no longer has an asset, or has another, makes the output stale', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    const originals = await buildOriginals();
    const smaller = { ...fixture, lock: lockOfOriginals(originals.slice(1)) };
    assert.deepEqual(issueCodesOf(await verifyFixture(smaller)), ['MANIFEST_STALE']);
  });
});

test('a stale PNG name holding WebP bytes is caught by its content and its profile', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    const webp = await readFile(join(rootOf(fixture), 'app', 'ui', 'button.webp'));
    await republish(fixture, {
      from: 'app/ui/button.webp',
      to: 'app/ui/button.png',
      bytes: webp,
      mediaType: 'image/png',
    });
    assert.deepEqual(issueCodesOf(await verifyFixture(fixture)), [
      'MANIFEST_STALE',
      'OUTPUT_MISMATCH',
    ]);
  });
});

/** One original published twice: a byte-identical print master and a WebP for the screen. */
async function printAndScreenOriginals(): Promise<FixtureOriginal[]> {
  const bytes = await pngOf(transparentArtwork(9, 9));
  return [
    { source: 'print/cat.png', bytes, role: 'print-master', id: 'print.cat' },
    { source: 'app/ui/cat.png', bytes, profile: 'ui-strict', id: 'screen.cat' },
  ];
}

test('a print master and a screen variant of one original keep their own IDs, roles and bytes', async () => {
  await publishedFixture(await printAndScreenOriginals(), BUILD_CONFIG, async (fixture) => {
    assert.deepEqual((await verifyFixture(fixture)).issues, []);
    const text = await readFile(join(rootOf(fixture), RUNTIME_MANIFEST_NAME), 'utf8');
    const { assets } = JSON.parse(text) as {
      assets: Record<
        string,
        { role?: string; sha256: string; sourceSha256: string; mediaType: string }
      >;
    };
    const print = assets['print.cat'];
    const screen = assets['screen.cat'];
    assert.equal(print?.role, 'print-master');
    assert.equal(print.sha256, print.sourceSha256, 'the print master is the original');
    assert.equal(screen?.sourceSha256, print.sourceSha256);
    assert.equal(screen.mediaType, 'image/webp');
  });
});

test('a print master that is not the original byte for byte is stale', async () => {
  await publishedFixture(await printAndScreenOriginals(), BUILD_CONFIG, async (fixture) => {
    const resized = await pngOf(transparentArtwork(4, 4));
    await republish(fixture, {
      from: 'print/cat.png',
      to: 'print/cat.png',
      bytes: resized,
      mediaType: 'image/png',
    });
    assert.deepEqual(issueCodesOf(await verifyFixture(fixture)), ['MANIFEST_STALE']);
  });
});

test('a voice line that is not the original byte for byte is stale', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await republish(fixture, {
      from: 'voice/hu/hello.mp3',
      to: 'voice/hu/hello.mp3',
      bytes: Buffer.from('ID3 jello'),
      mediaType: 'audio/mpeg',
    });
    assert.deepEqual(issueCodesOf(await verifyFixture(fixture)), ['MANIFEST_STALE']);
  });
});

test('in generation mode the claims a build that died left next to the root fail verify too', async () => {
  await publishedFixture(await buildOriginals(), GENERATION_CONFIG, async (fixture) => {
    const { claims } = workDirectoryOf(rootOf(fixture));
    await mkdir(claims, { recursive: true });
    await writeFile(join(claims, 'build-0b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.json'), '{}');
    assert.deepEqual(issueCodesOf(await verifyFixture(fixture)), ['INTERRUPTED_PUBLICATION']);
  });
});

test('in generation mode what a path-preserving build left next to the root fails verify', async () => {
  await publishedFixture(await buildOriginals(), GENERATION_CONFIG, async (fixture) => {
    await mkdir(workDirectoryOf(rootOf(fixture)).staging, { recursive: true });
    assert.deepEqual(issueCodesOf(await verifyFixture(fixture)), ['INTERRUPTED_PUBLICATION']);
  });
});

test('what an interrupted build left would ship, so it fails verify', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await mkdir(workDirectoryOf(rootOf(fixture)).staging, { recursive: true });
    assert.deepEqual(issueCodesOf(await verifyFixture(fixture)), ['INTERRUPTED_PUBLICATION']);
  });
});

test('without a published output there is nothing to verify; a foreign root is refused', async () => {
  await withBuildFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await assert.rejects(verifyFixture(fixture), failsBecause('NOT_FOUND'));
    await mkdir(rootOf(fixture));
    await writeFile(join(rootOf(fixture), 'legacy.png'), 'hand made');
    await assert.rejects(
      verifyFixture(fixture),
      failsBecause('OUTPUT_CONFLICT', 'OUTPUT_NOT_OWNED'),
    );
  });
});

test('in generation mode the published and retained generations are audited and strays block', async () => {
  await withBuildFixture(await buildOriginals(), GENERATION_CONFIG, async (fixture) => {
    const first = await buildOf(fixture);
    await buildOf({ ...fixture, lock: lockOfOriginals((await buildOriginals()).slice(1)) });
    const later = { ...fixture, lock: lockOfOriginals((await buildOriginals()).slice(1)) };
    assert.deepEqual((await verifyFixture(later)).issues, []);
    const layout = generationLayoutOf(rootOf(fixture));
    const retained = join(layout.generations, generationNameOf(first.assembled?.generation ?? ''));
    await writeFile(join(retained, 'voice', 'hu', 'hello.mp3'), 'changed');
    await writeFile(join(layout.root, 'notes.txt'), 'mine');
    assert.deepEqual(issueCodesOf(await verifyFixture(later)), [
      'OUTPUT_MISMATCH',
      'UNKNOWN_OUTPUT_NAME',
    ]);
  });
});

/** Legal source names that need encoding or look like query syntax, all copied as voice lines. */
function trickyOriginals(): FixtureOriginal[] {
  const names = [
    'a b.mp3',
    'c#d.mp3',
    'e&sig=1.mp3',
    'f%20g.mp3',
    'ünï ß.mp3',
    '10.mp3',
    'h=i+j.mp3',
  ];
  return names.map((name, index) => ({
    source: `voice/hu/${name}`,
    bytes: Buffer.from(`ID3 line ${String(index)}`),
    category: 'voice',
    locale: 'hu',
    id: `line.${String(index)}`,
  }));
}

test('whatever legal names the sources have, the build publishes nothing the scan flags', async () => {
  for (const config of [BUILD_CONFIG, GENERATION_CONFIG]) {
    await publishedFixture(trickyOriginals(), config, async (fixture) => {
      assert.deepEqual((await verifyFixture(fixture)).issues, []);
    });
  }
});

function changedEntry(
  entries: readonly ManifestEntry[],
  id: string,
  change: Partial<ManifestEntry['asset']>,
): ManifestEntry[] {
  return entries.map((entry) =>
    entry.id === id ? { id, asset: { ...entry.asset, ...change } } : entry,
  );
}

/** The voice entry claiming other bytes than its file has. */
function withMisdescribedVoice(manifest: ParsedManifest): ParsedManifest {
  const change = { sha256: 'b'.repeat(64), bytes: 1, mediaType: 'audio/ogg' };
  return { ...manifest, entries: changedEntry(manifest.entries, 'voice/hu/hello', change) };
}

/** The voice entry pointing at a file that is not published. */
function withUnlistedVoiceUrl(manifest: ParsedManifest): ParsedManifest {
  const change = { url: 'assets/voice/hu/other.mp3' };
  return { ...manifest, entries: changedEntry(manifest.entries, 'voice/hu/hello', change) };
}

/** A second entry naming the voice line's file. */
function withVoiceTwin(manifest: ParsedManifest): ParsedManifest {
  const voice = manifest.entries.find(({ id }) => id === 'voice/hu/hello');
  if (voice === undefined) return manifest;
  return { ...manifest, entries: [...manifest.entries, { ...voice, id: 'voice/hu/twin' }] };
}

function withGeneration(manifest: ParsedManifest): ParsedManifest {
  return { ...manifest, header: { ...manifest.header, generation: 'c'.repeat(64) } };
}

function withOtherProject(manifest: ParsedManifest): ParsedManifest {
  return { ...manifest, header: { ...manifest.header, projectId: 'other' } };
}

/** The part of each `<path>: <field>: <message>` issue naming the field. */
function fieldsOf(issues: readonly string[]): string[] {
  return issues.map((issue) => issue.split(': ')[1] ?? '');
}

function hasIssue(issues: readonly string[], matches: (issue: string) => boolean): boolean {
  return issues.some(matches);
}

function endsWithText(text: string): (issue: string) => boolean {
  return (issue) => issue.endsWith(text);
}

function includesText(text: string): (issue: string) => boolean {
  return (issue) => issue.includes(text);
}

function startsWithText(text: string): (issue: string) => boolean {
  return (issue) => issue.startsWith(text);
}

test('an entry that does not describe its published file is a mismatch, by field', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await rewriteManifest(fixture, withMisdescribedVoice);
    const messages = issuesWithCode(await verifyFixture(fixture), 'MANIFEST_MISMATCH');
    assert.deepEqual(fieldsOf(messages), ['sha256', 'bytes', 'mediaType']);
  });
});

test('an entry naming no published file, or two entries naming one, is a mismatch', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await rewriteManifest(fixture, withUnlistedVoiceUrl);
    const unlisted = issuesWithCode(await verifyFixture(fixture), 'MANIFEST_MISMATCH');
    assert.deepEqual(unlisted, [
      'voice/hu/hello: url: names no published file',
      'voice/hu/hello.mp3: entries: 0 manifest entries name this published file; exactly one must',
    ]);
  });
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await rewriteManifest(fixture, withVoiceTwin);
    const twice = issuesWithCode(await verifyFixture(fixture), 'MANIFEST_MISMATCH');
    assert.deepEqual(twice, [
      'voice/hu/hello.mp3: entries: 2 manifest entries name this published file; exactly one must',
    ]);
  });
});

test('a manifest naming another generation or another project is invalid', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    await rewriteManifest(fixture, withGeneration);
    assert.deepEqual(issuesWithCode(await verifyFixture(fixture), 'MANIFEST_INVALID').length, 1);
    await rewriteManifest(fixture, withOtherProject);
    const invalid = issuesWithCode(await verifyFixture(fixture), 'MANIFEST_INVALID');
    assert.ok(hasIssue(invalid, endsWithText('Written for another project or output mode.')));
  });
});

/** The first originals with the voice line's record changed as `change` says. */
async function withChangedVoice(change: Partial<FixtureOriginal>): Promise<FixtureOriginal[]> {
  const [image, voice] = (await buildOriginals()) as [FixtureOriginal, FixtureOriginal];
  return [image, { ...voice, id: 'voice/hu/hello', ...change }];
}

test('an entry whose provenance differs from its lock record is stale, by field', async () => {
  const changes: readonly [Partial<FixtureOriginal>, string][] = [
    [{ locale: 'en' }, 'locale'],
    [{ category: 'effects' }, 'category'],
    [{ role: 'narration' }, 'role'],
    [{ source: 'voice/hu/hello.wav' }, 'source'],
  ];
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    for (const [change, field] of changes) {
      const lock = lockOfOriginals(await withChangedVoice(change));
      const stale = issuesWithCode(await verifyFixture({ ...fixture, lock }), 'MANIFEST_STALE');
      assert.ok(hasIssue(stale, includesText(`${field} is not the locked one`)), field);
    }
  });
});

test('a locked asset that was never published is stale; an undefined profile is the plan’s problem', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    const extra: FixtureOriginal = {
      source: 'voice/hu/bye.mp3',
      bytes: Buffer.from('ID3 bye'),
      category: 'voice',
    };
    const larger = lockOfOriginals([...(await buildOriginals()), extra]);
    const stale = issuesWithCode(
      await verifyFixture({ ...fixture, lock: larger }),
      'MANIFEST_STALE',
    );
    assert.deepEqual(stale, ['voice/hu/bye: locked but not published; build again.']);
    const unknown = lockOfOriginals(await withChangedVoice({ profile: 'missing' }));
    assert.deepEqual(issueCodesOf(await verifyFixture({ ...fixture, lock: unknown })), [
      'PROFILE_UNKNOWN',
    ]);
  });
});

test('a print master must stay the original bytes even when its profile could convert it', async () => {
  const bytes = await pngOf(transparentArtwork(9, 9));
  const print: FixtureOriginal = {
    source: 'print/cat.png',
    bytes,
    role: 'print-master',
    id: 'print.cat',
  };
  await publishedFixture([print], BUILD_CONFIG, async (fixture) => {
    const resized = await pngOf(transparentArtwork(4, 4));
    await republish(fixture, {
      from: 'print/cat.png',
      to: 'print/cat.png',
      bytes: resized,
      mediaType: 'image/png',
    });
    const flexible = {
      profiles: { flexible: { kind: 'image', webp: { lossless: true, keepSmaller: true } } },
      profileRules: [{ match: 'print/**', profile: 'flexible' }],
    };
    const project = await checkedProjectIn(fixture.workspace, flexible);
    const stale = issuesWithCode(await verifyFixture({ ...fixture, project }), 'MANIFEST_STALE');
    assert.deepEqual(stale, [
      'print.cat: a copy must hold the original bytes exactly; build again.',
    ]);
  });
});

test('a key-shaped name in the published listing is flagged in the listing, by file', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    const voice = await readFile(
      join(fixture.project.paths.outputRoot, 'voice', 'hu', 'hello.mp3'),
    );
    await republish(fixture, {
      from: 'voice/hu/hello.mp3',
      to: 'voice/hu/AKIAABCDEFGHIJKLMNOP.mp3',
      bytes: voice,
      mediaType: 'audio/mpeg',
    });
    const unsafe = issuesWithCode(await verifyFixture(fixture), 'MANIFEST_UNSAFE_VALUE');
    assert.ok(hasIssue(unsafe, startsWithText('.cratepin-generation.json#/files/')));
    assert.ok(hasIssue(unsafe, startsWithText('cratepin-manifest.json#/assets/')));
  });
});

test('in generation mode a link where generations belong is refused, a misnamed generation flagged', async () => {
  await withBuildFixture(await buildOriginals(), GENERATION_CONFIG, async (fixture) => {
    const first = await buildOf(fixture);
    const later = { ...fixture, lock: lockOfOriginals((await buildOriginals()).slice(1)) };
    await buildOf(later);
    const layout = generationLayoutOf(fixture.project.paths.outputRoot);
    const retained = join(layout.generations, generationNameOf(first.assembled?.generation ?? ''));
    await rename(retained, join(layout.generations, 'ffffffffffffffff'));
    assert.deepEqual(issueCodesOf(await verifyFixture(later)), ['MANIFEST_INVALID']);
    const moved = join(fixture.workspace, 'moved');
    await rename(layout.generations, moved);
    await linkDirectory(moved, layout.generations);
    await assert.rejects(
      verifyFixture(later),
      failsBecause('OUTPUT_CONFLICT', 'OUTPUT_NOT_A_DIRECTORY'),
    );
  });
});

test('a converted asset built from other bytes than the locked original is stale', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    const [image, voice] = (await buildOriginals()) as [FixtureOriginal, FixtureOriginal];
    const redrawn = { ...image, bytes: await pngOf(transparentArtwork(7, 7)) };
    const lock = lockOfOriginals([redrawn, voice]);
    const stale = issuesWithCode(await verifyFixture({ ...fixture, lock }), 'MANIFEST_STALE');
    assert.ok(hasIssue(stale, includesText('sourceSha256 is not the locked one')));
  });
});

test('an entry with a category the tool never writes makes the manifest invalid', async () => {
  await publishedFixture(await buildOriginals(), BUILD_CONFIG, async (fixture) => {
    const manifestFile = join(rootOf(fixture), RUNTIME_MANIFEST_NAME);
    const text = await readFile(manifestFile, 'utf8');
    await writeFile(manifestFile, text.replace('"category": "voice"', '"category": "speech"'));
    assert.deepEqual(issueCodesOf(await verifyFixture(fixture)), ['MANIFEST_INVALID']);
  });
});

test('a retained generation listing holding a value that must not ship is flagged there', async () => {
  await withBuildFixture(await buildOriginals(), GENERATION_CONFIG, async (fixture) => {
    const first = await buildOf(fixture);
    const later = { ...fixture, lock: lockOfOriginals((await buildOriginals()).slice(1)) };
    await buildOf(later);
    const name = generationNameOf(first.assembled?.generation ?? '');
    const listingFile = join(
      generationLayoutOf(rootOf(fixture)).generations,
      name,
      '.cratepin-generation.json',
    );
    const listing = await readFile(listingFile, 'utf8');
    await writeFile(
      listingFile,
      listing.replace('voice/hu/hello.mp3', 'voice/hu/AKIAABCDEFGHIJKLMNOP.mp3'),
    );
    const unsafe = issuesWithCode(await verifyFixture(later), 'MANIFEST_UNSAFE_VALUE');
    assert.ok(hasIssue(unsafe, startsWithText(`generations/${name}/.cratepin-generation.json#`)));
  });
});
