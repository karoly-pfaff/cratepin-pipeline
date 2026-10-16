import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  offlineBuild,
  reportOf,
  runWithoutNetwork,
  snapshotOf,
  withProject,
} from '../building/projects.test-support.mjs';
import { withTempDirectory } from '../support/cli-runs.test-support.mjs';

test('Cratepin init creates its own config with namespaced defaults', async () => {
  await withTempDirectory(async (directory) => {
    const initialization = await runWithoutNetwork(directory, 'init', '--json');
    assert.equal(initialization.status, 0, initialization.stderr);
    assert.deepEqual(await readdir(directory), ['cratepin.config.json']);
    const config = JSON.parse(await readFile(join(directory, 'cratepin.config.json'), 'utf8'));
    assert.deepEqual(
      [config.lockFile, config.cacheDir, config.objectPrefix],
      ['cratepin-lock.json', '.cratepin-cache', 'cratepin/v1'],
    );
    assert.ok(!initialization.stderr.includes('NETWORK_ATTEMPT'), initialization.stderr);
  });
});

test('an earlier tool output marker never grants Cratepin ownership or permission to rewrite it', async () => {
  await withProject({ isWarm: true }, async (directory) => {
    const output = join(directory, 'public/assets');
    await mkdir(output);
    await writeFile(
      join(output, '.asset-pipeline-output.json'),
      JSON.stringify({
        schemaVersion: 1,
        tool: 'asset-pipeline',
        projectId: 'demo',
        outputMode: 'path-preserving',
      }),
    );
    await writeFile(join(output, 'asset-manifest.json'), 'an archived earlier release');
    const previousOutput = await snapshotOf(join(directory, 'public'));
    const build = await offlineBuild(directory);
    assert.equal(build.status, 9, build.stderr);
    assert.equal(reportOf(build).error.details.reason, 'OUTPUT_NOT_OWNED');
    assert.deepEqual(await snapshotOf(join(directory, 'public')), previousOutput);
  });
});

test('an old cache marker is refused without changing its contents', async () => {
  await withProject({ isWarm: false }, async (directory) => {
    const cache = join(directory, '.cratepin-cache');
    await mkdir(cache);
    await writeFile(
      join(cache, 'asset-cache.json'),
      JSON.stringify({ schemaVersion: 1, projectId: 'demo' }),
    );
    const previousCache = await snapshotOf(cache);
    const pull = await runWithoutNetwork(directory, 'pull', '--offline', '--json');
    assert.equal(pull.status, 9, pull.stderr);
    assert.equal(JSON.parse(pull.stderr).error.code, 'OUTPUT_CONFLICT');
    assert.deepEqual(await snapshotOf(cache), previousCache);
    assert.deepEqual(await readdir(join(directory, 'public')), ['index.html']);
  });
});
