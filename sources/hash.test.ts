import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { hashFile } from './hash.ts';
import { hashOpenedFile } from './opened-file-hash.ts';

async function withTempDirectory(
  runInDirectory: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'cratepin-hash-'));
  try {
    await runInDirectory(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('hash streams a file and matches the known SHA-256 and byte count', async () => {
  await withTempDirectory(async (directory) => {
    const path = join(directory, 'example.txt');
    await writeFile(path, 'abc');
    assert.deepEqual(await hashFile(path), {
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      bytes: 3,
    });
  });
});

test('hash refuses directories instead of reporting a digest', async () => {
  await withTempDirectory(async (directory) => {
    await assert.rejects(hashFile(directory), /Expected a regular file/);
  });
});

test('hashing an opened file can stop after a byte budget', async () => {
  await withTempDirectory(async (directory) => {
    const file = join(directory, 'long.bin');
    await writeFile(file, 'abcdefghijklmnopqrstuvwxyz');
    const openedFile = await open(file);
    try {
      assert.deepEqual(await hashOpenedFile(openedFile, 10), {
        sha256: createHash('sha256').update('abcdefghij').digest('hex'),
        bytes: 10,
      });
    } finally {
      await openedFile.close();
    }
  });
});
