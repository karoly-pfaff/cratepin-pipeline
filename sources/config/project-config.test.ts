import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ConfigIssue } from './pipeline-config.ts';
import { loadProjectConfig } from './project-config.ts';

const MINIMAL_CONFIG = { schemaVersion: 1, projectId: 'demo-game' };

function issuePathsOf(issues: readonly ConfigIssue[]): string[] {
  return issues.map((issue) => issue.path);
}

async function withNestedConfigDirectory(
  runInDirectory: (configDirectory: string) => Promise<void>,
): Promise<void> {
  const projectDirectory = await mkdtemp(join(tmpdir(), 'cratepin-config-'));
  try {
    const configDirectory = join(projectDirectory, 'nested', 'game');
    await mkdir(configDirectory, { recursive: true });
    await runInDirectory(configDirectory);
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
}

test('config paths resolve from the config file directory, not the working directory', async () => {
  await withNestedConfigDirectory(async (configDirectory) => {
    const configFile = join(configDirectory, 'cratepin.config.json');
    await writeFile(configFile, JSON.stringify({ ...MINIMAL_CONFIG, sourceDir: 'media/source' }));
    const load = await loadProjectConfig(configFile);
    assert.ok(load.ok);
    assert.equal(load.project.paths.sourceRoot, join(configDirectory, 'media', 'source'));
    assert.equal(load.project.paths.outputRoot, join(configDirectory, 'public', 'assets'));
  });
});

test('a file that is not JSON is a config issue at the root, not a crash', async () => {
  await withNestedConfigDirectory(async (configDirectory) => {
    const configFile = join(configDirectory, 'cratepin.config.json');
    await writeFile(configFile, '{ not json');
    const load = await loadProjectConfig(configFile);
    assert.ok(!load.ok);
    assert.deepEqual(issuePathsOf(load.issues), ['/']);
  });
});

test('a missing config file fails as a filesystem error', async () => {
  await withNestedConfigDirectory(async (configDirectory) => {
    await assert.rejects(loadProjectConfig(join(configDirectory, 'missing.json')), {
      code: 'ENOENT',
    });
  });
});

test('a duplicated key in the file is an issue, so JSON cannot silently hide a value', async () => {
  await withNestedConfigDirectory(async (configDirectory) => {
    const configFile = join(configDirectory, 'cratepin.config.json');
    await writeFile(
      configFile,
      '{"schemaVersion":1,"projectId":"demo","r2":{"bucketEnv":"X"},"r2":{}}',
    );
    const load = await loadProjectConfig(configFile);
    assert.ok(!load.ok);
    assert.deepEqual(issuePathsOf(load.issues), ['/r2']);
  });
});

test('a config larger than 1 MiB is an issue at the root, never parsed', async () => {
  await withNestedConfigDirectory(async (configDirectory) => {
    const configFile = join(configDirectory, 'cratepin.config.json');
    const padded = `${JSON.stringify(MINIMAL_CONFIG).slice(0, -1)}${' '.repeat(1024 * 1024)}}`;
    await writeFile(configFile, padded);
    const load = await loadProjectConfig(configFile);
    assert.ok(!load.ok);
    assert.deepEqual(issuePathsOf(load.issues), ['/']);
  });
});
