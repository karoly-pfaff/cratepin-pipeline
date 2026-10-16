import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { pngOf, transparentArtwork } from '../../media/testing/media-fixtures.test-support.ts';
import {
  buildAllOutputs,
  FAILURE_PROFILES,
  failsBecause,
  withBuildFixture,
} from '../build-fixtures.test-support.ts';
import { stageOutputTree } from './staged-tree.ts';

test('a cached output that changed before staging is never staged as it is', async () => {
  const originals = [
    { source: 'ok.png', bytes: await pngOf(transparentArtwork()), profile: 'flexible' },
  ];
  await withBuildFixture(originals, FAILURE_PROFILES, async (fixture) => {
    const { built } = await buildAllOutputs(fixture);
    const [asset] = built;
    assert.ok(asset !== undefined);
    await writeFile(asset.conversion.outputFile, 'changed meanwhile');
    const directory = join(fixture.workspace, 'staging');
    await mkdir(directory);
    await assert.rejects(
      stageOutputTree({ directory, built, toolFiles: [] }),
      failsBecause('INTEGRITY_MISMATCH', 'STAGED_FILE_MISMATCH'),
    );
  });
});

test('staging stops when cancelled and writes nothing more', async () => {
  const originals = [
    { source: 'ok.png', bytes: await pngOf(transparentArtwork()), profile: 'flexible' },
  ];
  await withBuildFixture(originals, FAILURE_PROFILES, async (fixture) => {
    const { built } = await buildAllOutputs(fixture);
    const directory = join(fixture.workspace, 'staging');
    await mkdir(directory);
    await assert.rejects(
      stageOutputTree({ directory, built, toolFiles: [], signal: AbortSignal.abort() }),
      failsBecause('CANCELLED'),
    );
    assert.deepEqual(await readdir(directory), []);
  });
});

test('a copied original that changed in the cache before staging is never staged as it is', async () => {
  const originals = [
    { source: 'voice/hi.mp3', bytes: Buffer.from('ID3 hello'), category: 'voice' as const },
  ];
  await withBuildFixture(originals, FAILURE_PROFILES, async (fixture) => {
    const { built } = await buildAllOutputs(fixture);
    const [asset] = built;
    assert.ok(asset !== undefined);
    await writeFile(asset.conversion.outputFile, 'ID3 jello');
    const directory = join(fixture.workspace, 'staging');
    await mkdir(directory);
    await assert.rejects(
      stageOutputTree({ directory, built, toolFiles: [] }),
      failsBecause('INTEGRITY_MISMATCH', 'STAGED_FILE_MISMATCH'),
    );
  });
});
