import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { withTempDirectory } from '../support/cli-runs.test-support.mjs';

async function checkDocuments(files) {
  let checked;
  await withTempDirectory(async (directory) => {
    await mkdir(join(directory, 'scripts'));
    await copyFile(
      new URL('../../scripts/check-docs.mjs', import.meta.url),
      join(directory, 'scripts/check-docs.mjs'),
    );
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(directory, name)), { recursive: true });
      await writeFile(join(directory, name), content);
    }
    checked = spawnSync(process.execPath, [join(directory, 'scripts/check-docs.mjs')], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
  });
  assert.ok(checked);
  assert.equal(checked.error, undefined);
  return checked;
}

test('public documentation still rejects a broken nested guide link', async () => {
  const checked = await checkDocuments({ 'docs/nested/guide.md': '[Missing](../absent.md)' });
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /absent\.md/u);
});

test('private context and retained candidate notes do not enter the public link scan', async () => {
  const checked = await checkDocuments({
    'README.md': '[Guide](docs/guide.md)',
    'docs/guide.md': '[Home](../README.md)',
    '.local/backlog/handoff.md': '[Historical](missing.md)',
    '.cratepin-state/candidates/old/CHANGE_NOTES.md': '[Historical](missing-guide.md)',
  });
  assert.equal(checked.status, 0, checked.stderr);
});

for (const target of ['.local/decision.md', '.cratepin-state/candidate.md', '../outside.md']) {
  test(`public documents cannot depend on excluded context: ${target}`, async () => {
    const checked = await checkDocuments({
      'README.md': `[Private](${target})`,
      '.local/decision.md': 'Private decision.',
      '.cratepin-state/candidate.md': 'Retained candidate.',
    });
    assert.notEqual(checked.status, 0);
    assert.ok(checked.stderr.includes(target), checked.stderr);
  });
}
