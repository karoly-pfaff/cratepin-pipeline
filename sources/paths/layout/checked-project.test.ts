import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { ConfigIssue } from '../../config/pipeline-config.ts';
import { CheckedProject, loadCheckedProject } from './checked-project.ts';
import { withWorkspace } from './layout-fixtures.test-support.ts';

function issuePathsOf(issues: readonly ConfigIssue[]): string[] {
  return issues.map((issue) => issue.path);
}

async function writeConfig(directory: string, config: object): Promise<string> {
  const configFile = join(directory, 'cratepin.config.json');
  await writeFile(configFile, JSON.stringify(config));
  return configFile;
}

test('a valid config with a safe layout yields a CheckedProject', async () => {
  await withWorkspace(async (workspace) => {
    const load = await loadCheckedProject(
      await writeConfig(workspace, { schemaVersion: 1, projectId: 'demo' }),
    );
    assert.ok(load.ok);
    assert.ok(load.project instanceof CheckedProject);
    assert.equal(load.project.paths.configDirectory, workspace);
  });
});

test('schema issues and layout issues both prevent a CheckedProject', async () => {
  await withWorkspace(async (workspace) => {
    const invalidSchema = await loadCheckedProject(
      await writeConfig(workspace, { schemaVersion: 2 }),
    );
    assert.ok(!invalidSchema.ok);
    await mkdir(join(workspace, 'public'));
    await writeFile(
      join(workspace, 'public', 'assets'),
      'a file where the output directory belongs',
    );
    const unsafeLayout = await loadCheckedProject(
      await writeConfig(workspace, { schemaVersion: 1, projectId: 'demo' }),
    );
    assert.ok(!unsafeLayout.ok);
    assert.deepEqual(issuePathsOf(unsafeLayout.issues), ['/outputDir']);
  });
});

function configDirectoryOf(project: CheckedProject): string {
  return project.paths.configDirectory;
}

test('a plain object with the same fields is not accepted as a CheckedProject', async () => {
  await withWorkspace(async (workspace) => {
    const load = await loadCheckedProject(
      await writeConfig(workspace, { schemaVersion: 1, projectId: 'demo' }),
    );
    assert.ok(load.ok);
    const lookalike = { config: load.project.config, paths: load.project.paths };
    // @ts-expect-error Only the preflight can produce a CheckedProject; typecheck fails if this compiles.
    assert.equal(configDirectoryOf(lookalike), workspace);
  });
});
