import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { PipelineError } from '../../errors.ts';
import { readTextWithin } from './bounded-text.ts';
import { withWorkspace } from '../layout/layout-fixtures.test-support.ts';

function isInvalidDataAt(path: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof PipelineError && error.code === 'INVALID_DATA' && error.details.path === path;
}

test('a file within the bound is read whole, also across several chunks', async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, 'lock.json');
    const text = 'é'.repeat(100_000);
    await writeFile(path, text);
    assert.equal(await readTextWithin(path, Buffer.byteLength(text)), text);
  });
});

test('a file one byte over the bound is refused as oversized', async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, 'lock.json');
    await writeFile(path, 'x'.repeat(201));
    assert.equal(await readTextWithin(path, 200), undefined);
  });
});

test('a directory where a file was expected is invalid data', async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, 'config.json');
    await mkdir(path);
    await assert.rejects(readTextWithin(path, 200), isInvalidDataAt(path));
  });
});
