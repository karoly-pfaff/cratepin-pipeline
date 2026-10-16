import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { linkDirectory, withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { checkOutputFile, directoriesLeadingTo, readOutputFile } from './output-files.ts';

test('the directories leading to a path come outermost first, the file itself excluded', () => {
  assert.deepEqual(directoriesLeadingTo('a/b/c.png'), ['a', 'a/b']);
  assert.deepEqual(directoriesLeadingTo('c.png'), []);
});

test('a directory or a directory link at an output file name is never that file', async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'cat.png'));
    const expected = { sha256: '0'.repeat(64), bytes: 1 };
    assert.equal(await checkOutputFile(join(workspace, 'cat.png'), expected), 'corrupt');
    await mkdir(join(workspace, 'elsewhere'));
    await linkDirectory(join(workspace, 'elsewhere'), join(workspace, 'linked.json'));
    assert.equal((await readOutputFile(join(workspace, 'linked.json'), 10)).state, 'corrupt');
    assert.equal((await readOutputFile(join(workspace, 'missing.json'), 10)).state, 'absent');
  });
});
