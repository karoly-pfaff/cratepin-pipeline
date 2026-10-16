import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { withTempDirectory } from './cli-runs.test-support.mjs';

const TEMP_VARIABLES = ['TMPDIR', 'TMP', 'TEMP'];

test('temporary fixtures expand aliased temp roots before strict realpath guards', async (context) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'cratepin-temp-alias-')));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const originalEnvironment = new Map(TEMP_VARIABLES.map((name) => [name, process.env[name]]));
  context.after(() => {
    for (const name of TEMP_VARIABLES) {
      const original = originalEnvironment.get(name);
      if (original === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = original;
    }
  });
  const canonicalParent = join(parent, 'actual');
  const aliasedParent = join(parent, 'alias');
  await mkdir(canonicalParent);
  await symlink(canonicalParent, aliasedParent, 'junction');
  for (const name of TEMP_VARIABLES) process.env[name] = aliasedParent;
  await withTempDirectory(async (directory) => {
    assert.equal(directory, await realpath(directory));
    assert.equal(dirname(directory), canonicalParent);
  });
});
