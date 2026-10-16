import assert from 'node:assert/strict';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { writeNewFile } from './create-only-files.ts';
import { withWorkspace } from '../layout/layout-fixtures.test-support.ts';

/** Chunks that fail before the first one, while the file is still being opened. */
async function* failingAtOnce(): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  throw new Error('the source broke');
  yield new Uint8Array();
}

async function* chunksOf(text: string): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield Buffer.from(text);
}

test('a new file holds exactly the chunks', async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, 'new.part');
    await writeNewFile(path, chunksOf('cat pixels'), undefined);
    assert.equal(await readFile(path, 'utf8'), 'cat pixels');
  });
});

test('an existing file is never replaced', async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, 'taken.part');
    await writeFile(path, 'first');
    await assert.rejects(writeNewFile(path, chunksOf('second'), undefined), { code: 'EEXIST' });
    assert.equal(await readFile(path, 'utf8'), 'first');
  });
});

test('a failed write settles only after the file is closed, so removing it leaves nothing', async () => {
  await withWorkspace(async (workspace) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const path = join(workspace, `failed-${String(attempt)}.part`);
      await assert.rejects(writeNewFile(path, failingAtOnce(), undefined), /the source broke/u);
      await rm(path, { force: true });
      assert.deepEqual(await readdir(workspace), [], `attempt ${String(attempt)}`);
    }
  });
});

test('a cancelled write settles only after the file is closed as well', async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, 'cancelled.part');
    await assert.rejects(writeNewFile(path, chunksOf('never'), AbortSignal.abort()), {
      name: 'AbortError',
    });
    await rm(path, { force: true });
    assert.deepEqual(await readdir(workspace), []);
  });
});
