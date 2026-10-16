import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  attemptsIn,
  offlineBuild,
  reportOf,
  runWithoutNetwork,
  snapshotOf,
  withProject,
} from '../building/projects.test-support.mjs';
import { DEFAULT_CONFIG_FILE } from '../support/cli-runs.test-support.mjs';

async function selectPngProfile(directory) {
  const configFile = join(directory, DEFAULT_CONFIG_FILE);
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  await writeFile(
    configFile,
    JSON.stringify({
      ...config,
      profiles: { 'ui-strict': { kind: 'image', resize: { width: 9, height: 9, fit: 'inside' } } },
    }),
  );
}

function assertNetworkFree(run, status) {
  assert.equal(run.status, status, run.stderr);
  assert.deepEqual(attemptsIn(run), []);
}

async function assertDimensionsVerified(directory) {
  assertNetworkFree(await offlineBuild(directory), 0);
  await rm(join(directory, '.cratepin-cache'), { recursive: true });
  const fresh = await snapshotOf(directory);
  assertNetworkFree(await runWithoutNetwork(directory, 'verify', '--json'), 0);
  assert.deepEqual(await snapshotOf(directory), fresh);
  const manifestFile = join(directory, 'public', 'assets', 'cratepin-manifest.json');
  const canonical = await readFile(manifestFile, 'utf8');
  const changedText = canonical.replace(
    '"width": 9,\n      "height": 9,',
    '"width": 999,\n      "height": 777,',
  );
  assert.notEqual(changedText, canonical);
  await writeFile(manifestFile, changedText);
  const changed = await snapshotOf(directory);
  const refused = await runWithoutNetwork(directory, 'verify', '--json');
  assertNetworkFree(refused, 8);
  assert.deepEqual(
    reportOf(refused).issues.map(({ code }) => code),
    ['MANIFEST_MISMATCH'],
  );
  assert.deepEqual(await snapshotOf(directory), changed);
  assert.equal(Object.keys(fresh).filter((path) => fresh[path] !== changed[path]).length, 1);
}

for (const outputMode of ['path-preserving', 'generation']) {
  for (const isWebp of [false, true]) {
    test(`credential-free ${outputMode} ${isWebp ? 'WebP' : 'PNG'} verify checks dimensions under the network blocker`, async () => {
      await withProject(
        { isWarm: true, transport: 's3-readonly', outputMode },
        async (directory) => {
          if (!isWebp) await selectPngProfile(directory);
          await assertDimensionsVerified(directory);
        },
      );
    });
  }
}
