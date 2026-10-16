import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { readPublishedManifest } from './manifest-reading.ts';
import { RUNTIME_MANIFEST_NAME } from '../layout/output-paths.ts';

async function stateOf(manifest: string | undefined): Promise<string> {
  let state = '';
  await withWorkspace(async (workspace) => {
    if (manifest !== undefined) await writeFile(join(workspace, RUNTIME_MANIFEST_NAME), manifest);
    state = (await readPublishedManifest(workspace)).state;
  });
  return state;
}

test('a published manifest is read by ID with its URLs and hashes', async () => {
  await withWorkspace(async (workspace) => {
    const manifest = { assets: { '10': { url: 'assets/10.png', sha256: 'a', bytes: 1 } } };
    await writeFile(join(workspace, RUNTIME_MANIFEST_NAME), JSON.stringify(manifest));
    const published = await readPublishedManifest(workspace);
    assert.ok(published.state === 'present');
    assert.deepEqual([...published.assets], [['10', { url: 'assets/10.png', sha256: 'a' }]]);
  });
});

test('a missing manifest is absent; anything not a manifest is unreadable, never trusted', async () => {
  assert.equal(await stateOf(undefined), 'absent');
  const unreadable = [
    'not json',
    '{"assets":{},"assets":{}}',
    '{"assets":[]}',
    '[]',
    '{"assets":{"a":{"url":"x"}}}',
    '{"assets":{"a":"x"}}',
  ];
  for (const text of unreadable) assert.equal(await stateOf(text), 'unreadable', text);
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, RUNTIME_MANIFEST_NAME));
    assert.equal((await readPublishedManifest(workspace)).state, 'unreadable');
  });
});
