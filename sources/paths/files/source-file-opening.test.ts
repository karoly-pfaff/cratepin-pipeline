import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { PipelineError } from '../../errors.ts';
import { withWorkspace } from '../layout/layout-fixtures.test-support.ts';
import { openSourceFile } from './source-file-opening.ts';

function isInvalidDataAt(path: string) {
  return (error: unknown): boolean =>
    error instanceof PipelineError && error.code === 'INVALID_DATA' && error.details.path === path;
}

test('a directory in place of a source file is invalid data naming its path', async () => {
  await withWorkspace(async (workspace) => {
    const path = join(workspace, 'cat.png');
    await mkdir(path);
    await assert.rejects(openSourceFile(path), isInvalidDataAt(path));
  });
});
