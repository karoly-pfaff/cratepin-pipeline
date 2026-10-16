import assert from 'node:assert/strict';
import { readdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { originalPathOf } from '../../cache/cache-layout.ts';
import { compareCodeUnits } from '../../catalog/ordering.ts';
import {
  gradientBackgroundPng,
  headerOnlyPng,
  paletteNoisePng,
  pngOf,
  transparentArtwork,
} from '../../media/testing/media-fixtures.test-support.ts';
import type { SourceRecord } from '../../lock/source-lock.ts';
import { concurrencyGate } from '../../storage/transfer/bounded-tasks.ts';
import type { ConcurrencyGate } from '../../storage/transfer/bounded-tasks.ts';
import { imageGateFor, MAX_IMAGE_READ_BYTES } from './asset-outputs.ts';
import type { BuiltAsset } from './asset-outputs.ts';
import type { FixtureOriginal } from '../build-fixtures.test-support.ts';
import {
  buildAllOutputs,
  FAILURE_PROFILES,
  failsBecause,
  issueSummaries,
  withBuildFixture,
} from '../build-fixtures.test-support.ts';

function builtSources(built: readonly BuiltAsset[]): string[] {
  return built.map(({ record }) => record.source).toSorted(compareCodeUnits);
}

test('an asset that cannot be converted becomes its issue; every other asset is built', async () => {
  const originals = [
    { source: 'ok.png', bytes: await pngOf(transparentArtwork()), profile: 'flexible' },
    { source: 'broken.png', bytes: Buffer.from('not a png at all'), profile: 'flexible' },
    {
      source: 'print.png',
      bytes: await gradientBackgroundPng(),
      profile: 'box',
      role: 'print-master',
    },
    { source: 'voice.mp3', bytes: Buffer.from('ID3 voice'), category: 'voice' as const },
  ];
  await withBuildFixture(originals, FAILURE_PROFILES, async (fixture) => {
    const result = await buildAllOutputs(fixture);
    assert.deepEqual(builtSources(result.built), ['ok.png', 'voice.mp3']);
    assert.deepEqual(issueSummaries(result.issues), [
      'IMAGE_UNREADABLE broken.png',
      'ROLE_NEEDS_COPY print.png',
    ]);
    assert.deepEqual(await readdir(fixture.layout.incoming), [], 'no part file is left');
  });
});

test('an original that leaves the cache during the build stops it; it is no asset issue', async () => {
  const originals = [
    { source: 'ok.png', bytes: await pngOf(transparentArtwork()), profile: 'flexible' },
  ];
  await withBuildFixture(originals, FAILURE_PROFILES, async (fixture) => {
    const [record] = fixture.lock.assets;
    assert.ok(record !== undefined);
    await rm(originalPathOf(fixture.layout, record.sha256));
    await assert.rejects(buildAllOutputs(fixture), failsBecause('NOT_FOUND'));
  });
});

test('an original whose content is another image type than its name says is refused', async () => {
  // Lossy WebP of this palette noise is larger, so the flexible profile keeps the PNG content.
  const misnamed = [
    { source: 'art.webp', bytes: await paletteNoisePng(), profile: 'lossy-flexible' },
  ];
  await withBuildFixture(misnamed, FAILURE_PROFILES, async (fixture) => {
    const result = await buildAllOutputs(fixture);
    assert.deepEqual(result.built, []);
    assert.deepEqual(issueSummaries(result.issues), ['OUTPUT_TYPE_UNEXPECTED art.webp']);
  });
});

/** The verified original's bytes changed in the cache: shorter, longer or the same size. */
const CHANGED_ORIGINALS: readonly [string, (bytes: Buffer) => Buffer][] = [
  ['shrunk', (bytes) => bytes.subarray(0, bytes.length - 1)],
  ['grown', (bytes) => Buffer.concat([bytes, Buffer.from('more')])],
  [
    'changed at the same size',
    (bytes) =>
      Buffer.from(bytes.map((byte, index) => (index === bytes.length - 1 ? byte ^ 1 : byte))),
  ],
];

for (const [change, changed] of CHANGED_ORIGINALS) {
  test(`an original ${change} in the cache during the build stops it as an integrity failure`, async () => {
    const bytes = await pngOf(transparentArtwork());
    const originals = [{ source: 'ok.png', bytes, profile: 'flexible' }];
    await withBuildFixture(originals, FAILURE_PROFILES, async (fixture) => {
      const [record] = fixture.lock.assets;
      assert.ok(record !== undefined);
      await writeFile(originalPathOf(fixture.layout, record.sha256), changed(bytes));
      await assert.rejects(buildAllOutputs(fixture), failsBecause('INTEGRITY_MISMATCH'));
    });
  });
}

function tooLargeToRead(record: SourceRecord): SourceRecord {
  return { ...record, bytes: MAX_IMAGE_READ_BYTES + 1 };
}

test('an image original too large to read for conversion is its issue, never read', async () => {
  const originals = [
    { source: 'huge.png', bytes: await pngOf(transparentArtwork()), profile: 'flexible' },
  ];
  await withBuildFixture(originals, FAILURE_PROFILES, async (fixture) => {
    const hugeAssets = fixture.lock.assets.map(tooLargeToRead);
    const result = await buildAllOutputs({
      ...fixture,
      lock: { ...fixture.lock, assets: hugeAssets },
    });
    assert.deepEqual(issueSummaries(result.issues), ['IMAGE_TOO_LARGE huge.png']);
  });
});

/** A gate of `limit` places that also counts its tasks and the most that ran at once. */
function countingGate(limit: number): {
  gate: ConcurrencyGate;
  calls: () => number;
  peak: () => number;
} {
  const inner = concurrencyGate(limit);
  let running = 0;
  let peak = 0;
  let calls = 0;
  const gate: ConcurrencyGate = (task) =>
    inner(async () => {
      calls += 1;
      running += 1;
      peak = Math.max(peak, running);
      try {
        return await task();
      } finally {
        running -= 1;
      }
    });
  return { gate, calls: () => calls, peak: () => peak };
}

async function noiseOriginals(count: number): Promise<FixtureOriginal[]> {
  const originals: FixtureOriginal[] = [];
  for (let index = 0; index < count; index += 1) {
    const pixels = transparentArtwork(32 + index, 24);
    originals.push({
      source: `noise-${String(index)}.png`,
      bytes: await pngOf(pixels),
      profile: 'flexible',
    });
  }
  return originals;
}

test('image conversions pass the image gate: at most its limit at once, though more assets run', async () => {
  await withBuildFixture(await noiseOriginals(12), FAILURE_PROFILES, async (fixture) => {
    const counting = countingGate(2);
    const result = await buildAllOutputs(fixture, { concurrency: 8, imageGate: counting.gate });
    assert.equal(result.built.length, 12);
    assert.equal(counting.calls(), 12, 'every conversion went through the gate');
    assert.equal(counting.peak(), 2);
  });
});

function codeOfSummary(summary: string): string {
  return summary.split(' ')[0] ?? '';
}

test('a burst of decode bombs is refused from their headers alone', async () => {
  const bombs = Array.from({ length: 20 }, (_, index) => ({
    source: `bomb-${String(index)}.png`,
    bytes: headerOnlyPng(20_000, 20_000),
    profile: 'flexible',
  }));
  await withBuildFixture(bombs, FAILURE_PROFILES, async (fixture) => {
    const started = performance.now();
    const result = await buildAllOutputs(fixture);
    assert.equal(result.issues.length, 20);
    assert.deepEqual(
      new Set(issueSummaries(result.issues).map(codeOfSummary)),
      new Set(['IMAGE_TOO_LARGE']),
    );
    assert.ok(performance.now() - started < 5000, 'nothing was decoded');
  });
});

/** The most of eight tasks `gate` lets run at once. */
async function peakThrough(gate: ConcurrencyGate): Promise<number> {
  let running = 0;
  let peak = 0;
  const task = async (): Promise<void> => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
  };
  await Promise.all(Array.from({ length: 8 }, () => gate(task)));
  return peak;
}

test('image conversions run at limits.imageConcurrency at once, never above the concurrency', async () => {
  assert.equal(await peakThrough(imageGateFor(2, 6)), 2);
  assert.equal(await peakThrough(imageGateFor(6, 3)), 3);
  assert.equal(await peakThrough(imageGateFor(1, 1)), 1);
});

function outputHashOf({ conversion }: BuiltAsset): string {
  return conversion.outputSha256;
}

function isRecordName(name: string): boolean {
  return name.endsWith('.json');
}

test('two assets with the same bytes and profile share one derivative and quarantine nothing', async () => {
  const bytes = await pngOf(transparentArtwork());
  const originals = [
    { source: 'a.png', bytes, profile: 'flexible' },
    { source: 'b.png', bytes, profile: 'flexible' },
  ];
  await withBuildFixture(originals, FAILURE_PROFILES, async (fixture) => {
    const { built, issues } = await buildAllOutputs(fixture);
    assert.deepEqual(issues, []);
    assert.equal(new Set(built.map(outputHashOf)).size, 1);
    const names = await readdir(fixture.layout.derivatives, { recursive: true });
    assert.equal(names.filter(isRecordName).length, 1);
    assert.deepEqual(await readdir(fixture.layout.quarantine), []);
  });
});
