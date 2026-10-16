import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { NODE_PUBLICATION_FILE_SYSTEM } from '../../output/publication/publication-files.ts';
import { failsBecause, buildAllOutputs, withBuildFixture } from '../build-fixtures.test-support.ts';
import type { FixtureOriginal } from '../build-fixtures.test-support.ts';
import { publishPathPreserving } from './build-publication.ts';
import { assembleOutput } from '../assembly/output-assembly.ts';

const ORIGINALS: FixtureOriginal[] = [
  {
    source: 'voice/hu/hello.mp3',
    bytes: Buffer.from('ID3 hello'),
    category: 'voice',
    locale: 'hu',
  },
  { source: 'voice/hu/bye.mp3', bytes: Buffer.from('ID3 bye'), category: 'voice', locale: 'hu' },
];

test('a staged tree that does not hold exactly what was assembled is never published', async () => {
  await withBuildFixture(ORIGINALS, {}, async (fixture) => {
    const { built } = await buildAllOutputs(fixture);
    const assembled = assembleOutput(fixture.project.config, built);
    await assert.rejects(
      publishPathPreserving({
        fileSystem: NODE_PUBLICATION_FILE_SYSTEM,
        project: fixture.project,
        built: built.slice(1),
        assembled,
      }),
      failsBecause('INTEGRITY_MISMATCH', 'STAGED_TREE_INVALID'),
    );
    assert.deepEqual(await readdir(join(fixture.workspace, 'public')), [], 'no root, no staging');
  });
});

test('an output already published byte for byte is found unchanged', async () => {
  await withBuildFixture(ORIGINALS, {}, async (fixture) => {
    const { built } = await buildAllOutputs(fixture);
    const publication = {
      fileSystem: NODE_PUBLICATION_FILE_SYSTEM,
      project: fixture.project,
      built,
      assembled: assembleOutput(fixture.project.config, built),
    };
    assert.equal((await publishPathPreserving(publication)).outcome, 'published');
    assert.equal((await publishPathPreserving(publication)).outcome, 'unchanged');
  });
});

test('a published file damaged since is not unchanged: the next build publishes it again', async () => {
  await withBuildFixture(ORIGINALS, {}, async (fixture) => {
    const { built } = await buildAllOutputs(fixture);
    const publication = {
      fileSystem: NODE_PUBLICATION_FILE_SYSTEM,
      project: fixture.project,
      built,
      assembled: assembleOutput(fixture.project.config, built),
    };
    assert.equal((await publishPathPreserving(publication)).outcome, 'published');
    const hello = join(fixture.project.paths.outputRoot, 'voice', 'hu', 'hello.mp3');
    await writeFile(hello, 'ID3 hel');
    assert.equal((await publishPathPreserving(publication)).outcome, 'published');
    assert.equal(await readFile(hello, 'utf8'), 'ID3 hello');
  });
});
