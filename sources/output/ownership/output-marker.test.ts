import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { linkDirectory, withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { classifyOutputRoot, OUTPUT_MARKER_NAME, outputMarkerTextOf } from './output-marker.ts';
import { outputRootError, outputRootIssue } from './root-refusals.ts';

const OWNER = { projectId: 'demo', outputMode: 'path-preserving' as const };

async function rootWith(
  workspace: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const root = join(workspace, 'public', 'assets');
  await mkdir(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return root;
}

/** `count` small files named f00.png, f01.png, and so on. */
function manyFiles(count: number): Record<string, string> {
  const names = Array.from(
    { length: count },
    (_, index) => `f${String(index).padStart(2, '0')}.png`,
  );
  return Object.fromEntries(names.map((name) => [name, 'x']));
}

test('the marker text is constant for one owner and names the tool, project and mode', () => {
  assert.equal(outputMarkerTextOf(OWNER), outputMarkerTextOf({ ...OWNER }));
  assert.deepEqual(JSON.parse(outputMarkerTextOf(OWNER)), {
    schemaVersion: 1,
    tool: 'cratepin',
    projectId: 'demo',
    outputMode: 'path-preserving',
  });
});

test('a missing root may be created, but never a missing parent', async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'public'));
    assert.deepEqual(await classifyOutputRoot(join(workspace, 'public', 'assets'), OWNER), {
      state: 'absent',
    });
    const orphan = join(workspace, 'nowhere', 'assets');
    const state = await classifyOutputRoot(orphan, OWNER);
    assert.deepEqual(state, { state: 'parent-missing' });
    assert.equal(outputRootError(state, orphan)?.code, 'NOT_FOUND');
  });
});

test('an empty root or one marked for this project and mode may be built into', async () => {
  await withWorkspace(async (workspace) => {
    const root = await rootWith(workspace, {});
    assert.deepEqual(await classifyOutputRoot(root, OWNER), { state: 'empty' });
    await writeFile(join(root, OUTPUT_MARKER_NAME), outputMarkerTextOf(OWNER));
    const state = await classifyOutputRoot(root, OWNER);
    assert.deepEqual(state, { state: 'owned' });
    assert.equal(outputRootIssue(state, root), undefined);
  });
});

test('another project, another mode or a broken marker is refused as an output conflict', async () => {
  await withWorkspace(async (workspace) => {
    const cases = [
      [
        outputMarkerTextOf({ ...OWNER, projectId: 'other' }),
        'foreign-project',
        'OUTPUT_FOREIGN_PROJECT',
      ],
      [
        outputMarkerTextOf({ ...OWNER, outputMode: 'generation' }),
        'mode-changed',
        'OUTPUT_MODE_CHANGED',
      ],
      [
        '{"schemaVersion":1,"tool":"cratepin","projectId":"demo","projectId":"demo"}',
        'marker-invalid',
        'OUTPUT_MARKER_INVALID',
      ],
      [
        '{"schemaVersion":2,"tool":"cratepin","projectId":"demo","outputMode":"generation"}',
        'marker-invalid',
        'OUTPUT_MARKER_INVALID',
      ],
      ['not json', 'marker-invalid', 'OUTPUT_MARKER_INVALID'],
    ] as const;
    for (const [markerText, expectedState, code] of cases) {
      const root = await rootWith(workspace, { [OUTPUT_MARKER_NAME]: markerText, 'a.png': 'x' });
      const state = await classifyOutputRoot(root, OWNER);
      assert.equal(state.state, expectedState, markerText);
      assert.equal(outputRootIssue(state, root)?.code, code);
      assert.equal(outputRootError(state, root)?.code, 'OUTPUT_CONFLICT');
    }
  });
});

test('a marker that is a directory or a link is not a marker', async () => {
  await withWorkspace(async (workspace) => {
    const root = await rootWith(workspace, {});
    await mkdir(join(root, OUTPUT_MARKER_NAME));
    assert.equal((await classifyOutputRoot(root, OWNER)).state, 'marker-invalid');
  });
  await withWorkspace(async (workspace) => {
    const root = await rootWith(workspace, {});
    const elsewhere = join(workspace, 'elsewhere');
    await mkdir(elsewhere);
    await linkDirectory(elsewhere, join(root, OUTPUT_MARKER_NAME));
    assert.equal((await classifyOutputRoot(root, OWNER)).state, 'marker-invalid');
  });
});

test('content without a marker is not owned, also a lone .gitkeep; the refusal names entries', async () => {
  await withWorkspace(async (workspace) => {
    const root = await rootWith(workspace, { '.gitkeep': '' });
    assert.deepEqual(await classifyOutputRoot(root, OWNER), {
      state: 'not-owned',
      names: ['.gitkeep'],
      nameCount: 1,
    });
  });
  await withWorkspace(async (workspace) => {
    const many = manyFiles(25);
    const root = await rootWith(workspace, many);
    const state = await classifyOutputRoot(root, OWNER);
    assert.ok(state.state === 'not-owned');
    assert.deepEqual([state.names.length, state.nameCount], [20, 25]);
    assert.match(outputRootIssue(state, root)?.message ?? '', /25 entries, e\.g\. f00\.png/u);
    assert.equal(outputRootIssue(state, root)?.code, 'OUTPUT_NOT_OWNED');
  });
});

test('a file or link where the root or its parent must be is refused, never built through', async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'public'));
    const root = join(workspace, 'public', 'assets');
    await writeFile(root, 'not a directory');
    const state = await classifyOutputRoot(root, OWNER);
    assert.deepEqual(state, { state: 'not-a-directory', path: root });
    assert.equal(outputRootIssue(state, root)?.code, 'OUTPUT_NOT_A_DIRECTORY');
    assert.equal(outputRootError(state, root)?.code, 'OUTPUT_CONFLICT');
  });
  await withWorkspace(async (workspace) => {
    await writeFile(join(workspace, 'public'), 'a file named public');
    const root = join(workspace, 'public', 'assets');
    assert.deepEqual(await classifyOutputRoot(root, OWNER), {
      state: 'not-a-directory',
      path: join(workspace, 'public'),
    });
  });
});

test('an existing root below a linked parent is refused too, not only a missing one', async () => {
  await withWorkspace(async (workspace) => {
    const realPublic = join(workspace, 'real-public');
    await mkdir(join(realPublic, 'assets'), { recursive: true });
    await linkDirectory(realPublic, join(workspace, 'public'));
    const root = join(workspace, 'public', 'assets');
    assert.deepEqual(await classifyOutputRoot(root, OWNER), {
      state: 'not-a-directory',
      path: join(workspace, 'public'),
    });
  });
});

test('a half-written generation marker in a path-preserving root is foreign content', async () => {
  await withWorkspace(async (workspace) => {
    const leftover = `${OUTPUT_MARKER_NAME}.0b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.tmp`;
    const root = await rootWith(workspace, { [leftover]: 'half' });
    assert.deepEqual(await classifyOutputRoot(root, OWNER), {
      state: 'not-owned',
      names: [leftover],
      nameCount: 1,
    });
    const generation = { ...OWNER, outputMode: 'generation' as const };
    assert.equal((await classifyOutputRoot(root, generation)).state, 'empty');
  });
});
