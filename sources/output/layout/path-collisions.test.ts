import assert from 'node:assert/strict';
import test from 'node:test';

import { outputPathConflicts } from './path-collisions.ts';

function codesAndIds(planned: Parameters<typeof outputPathConflicts>[0]): string[] {
  return outputPathConflicts(planned).map(
    ({ code, path, ids }) => `${code} ${path} ${ids.join('+')}`,
  );
}

test('distinct outputs and one asset with two possible paths do not clash', () => {
  assert.deepEqual(
    outputPathConflicts([
      { id: 'cat', paths: ['images/cat.png', 'images/cat.webp'] },
      { id: 'dog', paths: ['images/dog.png'] },
      { id: 'voice', paths: ['voice/hu/hello.mp3'] },
    ]),
    [],
  );
});

test('a flexible output that may become another source file clashes with it', () => {
  assert.deepEqual(
    codesAndIds([
      { id: 'cat', paths: ['images/cat.png', 'images/cat.webp'] },
      { id: 'cat-webp', paths: ['images/cat.webp'] },
    ]),
    ['OUTPUT_PATH_COLLISION images/cat.webp cat+cat-webp'],
  );
});

test('names that differ only in letter case clash, as on Windows and macOS', () => {
  assert.deepEqual(
    codesAndIds([
      { id: 'a', paths: ['images/Cat.png'] },
      { id: 'b', paths: ['images/cat.PNG'] },
    ]),
    ['OUTPUT_PATH_COLLISION images/cat.PNG a+b'],
  );
});

test('a directory spelled two ways clashes once, however many files it holds', () => {
  assert.deepEqual(
    codesAndIds([
      { id: 'a', paths: ['Images/a.png'] },
      { id: 'b', paths: ['images/b.png'] },
      { id: 'c', paths: ['images/c.png'] },
    ]),
    ['OUTPUT_PATH_COLLISION images a+b'],
  );
});

test('a file where another asset needs a directory clashes', () => {
  assert.deepEqual(
    codesAndIds([
      { id: 'file', paths: ['scenes/forest'] },
      { id: 'inside', paths: ['scenes/Forest/sky.png'] },
    ]),
    ['OUTPUT_PATH_COLLISION scenes/forest file+inside'],
  );
  const [conflict] = outputPathConflicts([
    { id: 'file', paths: ['scenes/forest'] },
    { id: 'inside', paths: ['scenes/Forest/sky.png'] },
  ]);
  assert.match(conflict?.message ?? '', /output file of "file", but "inside" needs a directory/u);
});

test('the runtime manifest name at the top of the output is reserved in any letter case', () => {
  assert.deepEqual(
    codesAndIds([
      { id: 'manifest', paths: ['Cratepin-Manifest.JSON'] },
      { id: 'nested', paths: ['data/cratepin-manifest.json'] },
    ]),
    ['OUTPUT_PATH_RESERVED Cratepin-Manifest.JSON manifest'],
  );
});

test('the reserved manifest name is refused as a directory too', () => {
  assert.deepEqual(codesAndIds([{ id: 'inside', paths: ['cratepin-manifest.json/data.png'] }]), [
    'OUTPUT_PATH_RESERVED cratepin-manifest.json/data.png inside',
  ]);
});

test('the output marker, the file listing and a marker being written are reserved too, in any case', () => {
  assert.deepEqual(
    codesAndIds([
      { id: 'marker', paths: ['.Cratepin-Output.json'] },
      { id: 'listing', paths: ['.cratepin-generation.json/x.png'] },
      {
        id: 'temporary',
        paths: ['.cratepin-output.json.0b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.tmp'],
      },
      { id: 'nested', paths: ['data/.cratepin-output.json'] },
    ]),
    [
      'OUTPUT_PATH_RESERVED .Cratepin-Output.json marker',
      'OUTPUT_PATH_RESERVED .cratepin-generation.json/x.png listing',
      'OUTPUT_PATH_RESERVED .cratepin-output.json.0b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.tmp temporary',
    ],
  );
});
