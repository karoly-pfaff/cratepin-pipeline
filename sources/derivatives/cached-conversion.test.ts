import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import { derivativePathsOf } from '../cache/cache-file-names.ts';
import type { CacheLayout } from '../cache/cache-layout.ts';
import { failsWith, withPreparedCache } from '../cache/cache-fixtures.test-support.ts';
import { sha256Of } from '../catalog/source-fixtures.test-support.ts';
import type { WebpEncoding } from '../config/pipeline-config.ts';
import { PipelineError } from '../errors.ts';
import { encoderFingerprint } from '../media/encoding/encoder-fingerprint.ts';
import {
  gradientBackgroundPng,
  paletteNoisePng,
} from '../media/testing/media-fixtures.test-support.ts';
import { derivativeKeyOf, normalizedPolicyOf } from '../media/policies/transform-policy.ts';
import type { ImagePolicy, TransformPolicy } from '../media/policies/transform-policy.ts';
import { convertWithCache } from './cached-conversion.ts';
import type { DerivativeRecord } from './derivative-record.ts';
import type { CachedConversion, CachedConversionRequest } from './cached-conversion.ts';

const MAX_PIXELS = 16_383 * 16_383;
const LOSSY: WebpEncoding = { lossless: false, quality: 80, alphaQuality: 100, keepSmaller: true };
const BACKGROUND = normalizedPolicyOf({ kind: 'image', webp: LOSSY }) as ImagePolicy;
const FINGERPRINT = encoderFingerprint();

function requestFor(
  layout: CacheLayout,
  bytes: Buffer,
  changes: Partial<Omit<CachedConversionRequest, 'layout'>> = {},
): CachedConversionRequest {
  return {
    layout,
    original: { bytes, mediaType: 'image/png', sha256: sha256Of(bytes) },
    policy: BACKGROUND,
    fingerprint: FINGERPRINT,
    maxImagePixels: MAX_PIXELS,
    ...changes,
  };
}

function pathsOf(request: CachedConversionRequest): { output: string; record: string } {
  const { layout, original, policy, fingerprint } = request;
  const key = derivativeKeyOf({ sourceSha256: original.sha256, policy, fingerprint });
  return derivativePathsOf(layout, original.sha256, key);
}

/** What a conversion reports besides its bytes and how it was obtained. */
function factsOf(
  result: CachedConversion,
): Omit<CachedConversion, 'bytes' | 'derivativeUse' | 'outputFile'> {
  const { mediaType, dimensions, sourceDimensions, choice, sourceBytes, outputBytes } = result;
  const { savedBytes, notices, outputSha256 } = result;
  return {
    mediaType,
    ...(dimensions === undefined ? {} : { dimensions }),
    ...(sourceDimensions === undefined ? {} : { sourceDimensions }),
    choice,
    sourceBytes,
    outputBytes,
    savedBytes,
    notices,
    outputSha256,
  };
}

/** Ways a cached output can go wrong, and whether something is left to quarantine. */
function damagesOf(
  output: string,
  bytes: Uint8Array,
): { name: string; apply: () => Promise<void>; isQuarantined: boolean }[] {
  const flipped = Buffer.from(bytes).map((value) => value ^ 1);
  return [
    { name: 'flipped bits', apply: () => writeFile(output, flipped), isQuarantined: true },
    {
      name: 'a lost byte',
      apply: () => writeFile(output, bytes.subarray(0, bytes.length - 1)),
      isQuarantined: true,
    },
    { name: 'removed', apply: () => rm(output), isQuarantined: false },
    {
      name: 'a directory instead',
      apply: async () => {
        await rm(output);
        await mkdir(output);
      },
      isQuarantined: true,
    },
  ];
}

function refusedBecause(reason: string): (error: unknown) => boolean {
  return (error) => error instanceof PipelineError && error.details.reason === reason;
}

function sameOutput(left: CachedConversion, right: CachedConversion): boolean {
  return Buffer.from(left.bytes).equals(right.bytes) && left.outputSha256 === right.outputSha256;
}

test('a derivative is made once, then reused after verifying its record and bytes', async () => {
  await withPreparedCache(async (layout) => {
    const request = requestFor(layout, await gradientBackgroundPng());
    const made = await convertWithCache(request);
    assert.equal(made.derivativeUse, 'made');
    assert.equal(made.outputSha256, sha256Of(made.bytes));
    const { output, record } = pathsOf(request);
    assert.ok((await readFile(output)).equals(made.bytes));
    const recorded = JSON.parse(await readFile(record, 'utf8')) as DerivativeRecord;
    assert.deepEqual([recorded.policy, recorded.fingerprint], [BACKGROUND, FINGERPRINT]);
    const reused = await convertWithCache(request);
    assert.equal(reused.derivativeUse, 'reused');
    assert.ok(sameOutput(made, reused));
    assert.deepEqual(factsOf(reused), factsOf(made), 'the same sizes, dimensions and notices');
    assert.deepEqual(await readdir(layout.incoming), [], 'no part file is left');
  });
});

test('the same pinned environment makes the same bytes again from scratch', async () => {
  await withPreparedCache(async (layout) => {
    const request = requestFor(layout, await gradientBackgroundPng());
    const first = await convertWithCache(request);
    await rm(layout.derivatives, { recursive: true });
    await mkdir(layout.derivatives);
    const second = await convertWithCache(request);
    assert.equal(second.derivativeUse, 'made');
    assert.ok(sameOutput(first, second), 'byte for byte the same output');
  });
});

test('a corrupt, truncated or replaced output is never served; it is made again', async () => {
  await withPreparedCache(async (layout) => {
    const request = requestFor(layout, await gradientBackgroundPng());
    const made = await convertWithCache(request);
    const { output } = pathsOf(request);
    let quarantined = 0;
    for (const { name, apply, isQuarantined } of damagesOf(output, made.bytes)) {
      await apply();
      const remade = await convertWithCache(request);
      assert.equal(remade.derivativeUse, 'remade', name);
      assert.ok(sameOutput(made, remade), name);
      if (isQuarantined) quarantined += 1;
      assert.equal((await readdir(layout.quarantine)).length, quarantined, name);
      assert.ok(
        (await readFile(output)).equals(made.bytes),
        'the cache holds the right bytes again',
      );
      assert.equal((await convertWithCache(request)).derivativeUse, 'reused');
    }
  });
});

test('a record that is unreadable or made from other inputs is never trusted', async () => {
  await withPreparedCache(async (layout) => {
    const request = requestFor(layout, await gradientBackgroundPng());
    const made = await convertWithCache(request);
    const { record } = pathsOf(request);
    const original = JSON.parse(await readFile(record, 'utf8')) as DerivativeRecord;
    const tampered = [
      'not json',
      JSON.stringify({ ...original, schemaVersion: 2 }),
      JSON.stringify({ ...original, policy: { ...original.policy, resize: null, kind: 'copy' } }),
      JSON.stringify({ ...original, fingerprint: { ...FINGERPRINT, libwebp: '0.0.1' } }),
      JSON.stringify({ ...original, sourceBytes: original.sourceBytes + 1 }),
      JSON.stringify({ ...original, output: { ...original.output, sha256: sha256Of('else') } }),
      JSON.stringify({ ...original, output: { ...original.output, mediaType: 'image/png' } }),
      JSON.stringify({ ...original, output: { ...original.output, width: 1, height: 1 } }),
      JSON.stringify({ ...original, sourceDimensions: { width: 1, height: 1 } }),
      JSON.stringify({ ...original, choice: 'kept-smaller' }),
      JSON.stringify({ ...original, notices: [{ code: 'SIZE_GREW', message: 'grew' }] }),
      JSON.stringify({ ...original, notices: [{ code: 'MADE_UP', message: 'unknown' }] }),
    ];
    for (const text of tampered) {
      await rm(record);
      await writeFile(record, text);
      const remade = await convertWithCache(request);
      assert.equal(remade.derivativeUse, 'remade', text.slice(0, 40));
      assert.ok(sameOutput(made, remade));
      assert.equal((await convertWithCache(request)).derivativeUse, 'reused');
    }
  });
});

test('a changed policy or encoder gives a new derivative and leaves the old one', async () => {
  await withPreparedCache(async (layout) => {
    const request = requestFor(layout, await gradientBackgroundPng());
    const first = await convertWithCache(request);
    const sharper: TransformPolicy = normalizedPolicyOf({
      kind: 'image',
      webp: { ...LOSSY, quality: 50 },
    });
    const otherCodec = { ...FINGERPRINT, libwebp: `${FINGERPRINT.libwebp}-patched` };
    for (const changes of [{ policy: sharper }, { fingerprint: otherCodec }]) {
      const changed = requestFor(layout, request.original.bytes as Buffer, changes);
      assert.equal((await convertWithCache(changed)).derivativeUse, 'made');
    }
    assert.equal((await readdir(layout.derivatives)).length, 6, 'three outputs, three records');
    assert.equal((await convertWithCache(request)).derivativeUse, 'reused');
    assert.equal(first.derivativeUse, 'made');
  });
});

test('a kept original in its own format is cached with its real media type', async () => {
  await withPreparedCache(async (layout) => {
    const bytes = await paletteNoisePng();
    const request = requestFor(layout, bytes);
    const made = await convertWithCache(request);
    const reused = await convertWithCache(request);
    for (const result of [made, reused]) {
      assert.deepEqual([result.choice, result.mediaType], ['kept-smaller', 'image/png']);
      assert.ok(Buffer.from(result.bytes).equals(bytes));
      assert.deepEqual(result.dimensions, { width: 128, height: 128 });
    }
    assert.deepEqual(factsOf(reused).notices, [factsOf(made).notices[0]]);
    assert.equal(factsOf(reused).notices[0]?.code, 'KEPT_SMALLER_FORMAT');
  });
});

test('the copy profile needs no derivative', async () => {
  await withPreparedCache(async (layout) => {
    const bytes = Buffer.from('RIFF voice');
    const copied = await convertWithCache({
      ...requestFor(layout, bytes, { policy: { kind: 'copy' }, maxImagePixels: 1 }),
      original: { bytes, mediaType: 'audio/wav', sha256: sha256Of(bytes) },
    });
    assert.deepEqual([copied.derivativeUse, copied.outputSha256], ['copied', sha256Of(bytes)]);
    assert.ok(Buffer.from(copied.bytes).equals(bytes));
    assert.deepEqual(await readdir(layout.derivatives), []);
  });
});

test('bytes that are not the pinned original are refused before anything is cached', async () => {
  await withPreparedCache(async (layout) => {
    const request = requestFor(layout, await gradientBackgroundPng());
    const swapped = { ...request.original, sha256: sha256Of('another original') };
    await assert.rejects(
      convertWithCache({ ...request, original: swapped }),
      failsWith('INTEGRITY_MISMATCH'),
    );
    assert.deepEqual(await readdir(layout.derivatives), []);
  });
});

test('role checks run before the lookup, so a cached screen version never serves a print master', async () => {
  await withPreparedCache(async (layout) => {
    const request = requestFor(layout, await gradientBackgroundPng());
    assert.equal((await convertWithCache(request)).derivativeUse, 'made');
    const printMaster = { ...request.original, role: 'print-master' };
    await assert.rejects(
      convertWithCache({ ...request, original: printMaster }),
      refusedBecause('ROLE_NEEDS_COPY'),
    );
  });
});

test('an output left without its record is not trusted; it is made again', async () => {
  await withPreparedCache(async (layout) => {
    const request = requestFor(layout, await gradientBackgroundPng());
    await convertWithCache(request);
    await rm(pathsOf(request).record);
    assert.equal((await convertWithCache(request)).derivativeUse, 'remade');
    assert.equal((await convertWithCache(request)).derivativeUse, 'reused');
  });
});

test('a warm cache refuses what a cold one does: a lowered pixel limit applies to reuse too', async () => {
  await withPreparedCache(async (layout) => {
    const request = requestFor(layout, await gradientBackgroundPng());
    assert.equal((await convertWithCache(request)).derivativeUse, 'made');
    await assert.rejects(
      convertWithCache({ ...request, maxImagePixels: 1000 }),
      refusedBecause('IMAGE_TOO_LARGE'),
    );
  });
});

test('a padded canvas over budget is refused before either a cold or warm derivative lookup', async () => {
  await withPreparedCache(async (layout) => {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#0f0' } })
      .png()
      .toBuffer();
    const policy = normalizedPolicyOf({
      kind: 'image',
      resize: { width: 64, height: 64, fit: 'contain' },
    });
    const request = requestFor(layout, bytes, { policy, maxImagePixels: 16 });
    await assert.rejects(convertWithCache(request), refusedBecause('IMAGE_TOO_LARGE'));
    assert.deepEqual(await readdir(layout.derivatives), []);
    const made = await convertWithCache({ ...request, maxImagePixels: 4096 });
    const { output, record } = pathsOf(request);
    const before = await readFile(record);
    await assert.rejects(convertWithCache(request), refusedBecause('IMAGE_TOO_LARGE'));
    assert.ok((await readFile(output)).equals(made.bytes));
    assert.ok((await readFile(record)).equals(before));
    assert.ok(Buffer.from(request.original.bytes).equals(bytes));
  });
});

/** Converts in a fresh Node process and prints the output's SHA-256. */
const CHILD_CONVERSION = `
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [modulePath, pngPath, policyText] = process.argv.slice(1);
const { convertImage } = await import(modulePath);
const original = { bytes: readFileSync(pngPath), mediaType: 'image/png' };
const image = await convertImage(original, JSON.parse(policyText), ${String(MAX_PIXELS)});
process.stdout.write(createHash('sha256').update(image.bytes).digest('hex'));
`;

function sha256InAnotherProcess(pngPath: string, policy: TransformPolicy): string {
  const modulePath = new URL('../media/original-conversion.ts', import.meta.url).href;
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', CHILD_CONVERSION, modulePath, pngPath, JSON.stringify(policy)],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

test('every kind of profile gives the same bytes again, also in another process', async () => {
  await withPreparedCache(async (layout, _project, workspace) => {
    const loose = await sharp(await paletteNoisePng())
      .png({ compressionLevel: 0 })
      .toBuffer();
    const box = { width: 256, height: 256 };
    const cases = [
      {
        bytes: await gradientBackgroundPng(),
        policy: BACKGROUND,
        kind: ['converted', 'image/webp', 512, 256],
      },
      {
        bytes: await gradientBackgroundPng(),
        policy: normalizedPolicyOf({ kind: 'image', webp: { ...LOSSY, lossless: true } }),
        kind: ['converted', 'image/webp', 512, 256],
      },
      {
        bytes: await gradientBackgroundPng(),
        policy: normalizedPolicyOf({ kind: 'image', resize: { ...box, fit: 'contain' } }),
        kind: ['converted', 'image/png', 256, 256],
      },
      {
        bytes: loose,
        kind: ['kept-smaller', 'image/png', 128, 128],
        policy: normalizedPolicyOf({
          kind: 'image',
          resize: { ...box, fit: 'inside' },
          webp: LOSSY,
        }),
      },
    ];
    for (const [index, { bytes, policy, kind }] of cases.entries()) {
      const made = await convertWithCache(requestFor(layout, bytes, { policy }));
      const { width, height } = made.dimensions ?? { width: 0, height: 0 };
      assert.deepEqual([made.choice, made.mediaType, width, height], kind, 'the kind of profile');
      const pngPath = join(workspace, `original-${String(index)}.png`);
      await writeFile(pngPath, bytes);
      assert.equal(sha256InAnotherProcess(pngPath, policy), made.outputSha256, made.choice);
    }
  });
});
