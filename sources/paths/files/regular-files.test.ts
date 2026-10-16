import assert from 'node:assert/strict';
import fileSystem, { appendFile, mkdir, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { sha256Of } from '../../catalog/source-fixtures.test-support.ts';
import { linkDirectory, withWorkspace } from '../layout/layout-fixtures.test-support.ts';
import { checkRegularFile, readRegularFile, streamRegularFile } from './regular-files.ts';

const MESSAGES = {
  cannotInspect: 'cannot inspect',
  cannotOpen: 'cannot open',
  notRegular: 'not regular',
};
const CAT = Buffer.from('cat pixels');
const EXPECTED = { sha256: sha256Of(CAT), bytes: CAT.length };

function growAfterInspection(context: TestContext, file: FileHandle, path: string): void {
  const originalStat = file.stat.bind(file);
  let inspections = 0;
  context.mock.method(file, 'stat', async () => {
    const snapshot = await originalStat();
    inspections += 1;
    if (inspections === 2) await appendFile(path, Buffer.alloc(1024));
    return snapshot;
  });
  context.mock.method(file, 'readFile', () => assert.fail('unbounded read'));
}

function openWithGrowingFile(context: TestContext, path: string): () => void {
  const originalOpen = fileSystem.open;
  const patchedOpen = context.mock.method(
    fileSystem,
    'open',
    async (...args: Parameters<typeof fileSystem.open>) => {
      const file = await originalOpen(...args);
      if (args[0] === path) growAfterInspection(context, file, path);
      return file;
    },
  );
  syncBuiltinESMExports();
  return () => {
    patchedOpen.mock.restore();
    syncBuiltinESMExports();
  };
}

test('a file growing after its size check is corrupt without an unbounded read', async (context) => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, 'growing');
    await writeFile(path, 'a');
    const restoreOpen = openWithGrowingFile(context, path);
    try {
      assert.deepEqual(await readRegularFile(path, 1, MESSAGES), { state: 'corrupt' });
      assert.equal((await fileSystem.stat(path)).size, 1025);
    } finally {
      restoreOpen();
    }
  });
});

test('a file is verified only with exactly the expected bytes', async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, 'cat.png');
    assert.equal(await checkRegularFile(path, EXPECTED, MESSAGES), 'absent');
    await writeFile(path, CAT);
    assert.equal(await checkRegularFile(path, EXPECTED, MESSAGES), 'verified');
    await writeFile(path, 'cat pixelz');
    assert.equal(await checkRegularFile(path, EXPECTED, MESSAGES), 'corrupt');
  });
});

test('a directory or link at the name is corrupt and never followed', async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'directory'));
    assert.equal(
      await checkRegularFile(join(workspace, 'directory'), EXPECTED, MESSAGES),
      'corrupt',
    );
    await mkdir(join(workspace, 'target'));
    await linkDirectory(join(workspace, 'target'), join(workspace, 'link'));
    assert.equal((await readRegularFile(join(workspace, 'link'), 100, MESSAGES)).state, 'corrupt');
  });
});

test('a read stops at its limit: a larger file is corrupt and not read', async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, 'cat.png');
    await writeFile(path, CAT);
    assert.deepEqual(await readRegularFile(path, CAT.length, MESSAGES), {
      state: 'present',
      bytes: CAT,
    });
    assert.deepEqual(await readRegularFile(path, CAT.length - 1, MESSAGES), { state: 'corrupt' });
    const chunks: Uint8Array[] = [];
    for await (const chunk of streamRegularFile(path, MESSAGES)) chunks.push(chunk);
    assert.ok(Buffer.concat(chunks).equals(CAT));
  });
});
