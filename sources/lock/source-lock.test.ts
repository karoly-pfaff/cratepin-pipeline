import assert from 'node:assert/strict';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { catalogSources } from '../catalog/asset-catalog.ts';
import type { CatalogedAsset, SourceCatalog } from '../catalog/asset-catalog.ts';
import { inventorySources } from '../catalog/inventory.ts';
import {
  checkedProjectIn,
  sha256Of,
  writeSources,
} from '../catalog/source-fixtures.test-support.ts';
import { PipelineError } from '../errors.ts';
import { withWorkspace } from '../paths/layout/layout-fixtures.test-support.ts';
import { lockDigest, objectKeyFor, serializeLock, stageLock } from './source-lock.ts';

const NAMESPACE = { objectPrefix: 'cratepin/v1', projectId: 'demo' };

function catalogedAsset(
  id: string,
  path: string,
  extra: Partial<CatalogedAsset> = {},
): CatalogedAsset {
  return {
    id,
    path,
    sha256: sha256Of(path),
    bytes: path.length,
    mediaType: 'image/png',
    category: 'image',
    ...extra,
  };
}

const ASSETS = [
  catalogedAsset('character.cat', 'images/cat.png', { role: 'actor', licence: 'CC-BY-4.0' }),
  catalogedAsset('images/dog', 'images/dog.png'),
  catalogedAsset('voice.hello', 'voice/hu/hello.png', { locale: 'hu' }),
];

function catalogOf(assets: readonly CatalogedAsset[]): SourceCatalog {
  return { assets, issues: [] };
}

test('a staged lock pins every original by hash, size and namespaced object key', () => {
  const lock = stageLock(NAMESPACE, catalogOf(ASSETS));
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.projectId, 'demo');
  assert.deepEqual(lock.assets[0], {
    id: 'character.cat',
    source: 'images/cat.png',
    sha256: sha256Of('images/cat.png'),
    bytes: 'images/cat.png'.length,
    mediaType: 'image/png',
    category: 'image',
    role: 'actor',
    licence: 'CC-BY-4.0',
    objectKey: `cratepin/v1/projects/demo/sources/sha256/${sha256Of('images/cat.png')}`,
  });
});

test('serialization is identical for every input order and has a fixed field order', () => {
  const forward = stageLock(NAMESPACE, catalogOf(ASSETS));
  const reversed = stageLock(NAMESPACE, catalogOf(ASSETS.toReversed()));
  const rotated = stageLock(NAMESPACE, catalogOf([...ASSETS.slice(1), ...ASSETS.slice(0, 1)]));
  const text = serializeLock(forward);
  assert.equal(serializeLock(reversed), text);
  assert.equal(serializeLock(rotated), text);
  assert.equal(lockDigest(reversed), lockDigest(forward));
  assert.ok(text.endsWith('}\n'));
  const firstRecordKeys = Object.keys((JSON.parse(text) as { assets: object[] }).assets[0] ?? {});
  assert.deepEqual(firstRecordKeys, [
    'id',
    'source',
    'sha256',
    'bytes',
    'mediaType',
    'category',
    'objectKey',
    'role',
    'licence',
  ]);
});

test('a lock never contains time, machine or absolute path, so two checkouts agree', async () => {
  const serializedLocks: string[] = [];
  for (const timestamp of [new Date('2020-01-01'), new Date('2030-06-15')]) {
    await withWorkspace(async (workspace) => {
      const sourceRoot = await writeSources(workspace, { 'images/cat.png': 'cat' });
      await utimes(join(sourceRoot, 'images', 'cat.png'), timestamp, timestamp);
      const project = await checkedProjectIn(workspace);
      const catalog = catalogSources(await inventorySources(project), []);
      const text = serializeLock(stageLock(project.config, catalog));
      const workspaceAsJson = JSON.stringify(workspace).slice(1, -1);
      const dateAsJson = timestamp.toISOString().slice(0, 10);
      assert.ok(!text.includes(workspaceAsJson) && !text.includes(dateAsJson));
      serializedLocks.push(text);
    });
  }
  assert.equal(serializedLocks[0], serializedLocks[1]);
});

test('a catalog with blocking issues cannot be staged', () => {
  const blocked: SourceCatalog = {
    assets: ASSETS,
    issues: [{ path: 'a.bmp', code: 'UNSUPPORTED_MEDIA', message: 'unsupported' }],
  };
  assert.throws(
    () => stageLock(NAMESPACE, blocked),
    (error) => error instanceof PipelineError && error.code === 'INVALID_DATA',
  );
});

test('object keys are content addressed inside the project namespace', () => {
  const sha256 = sha256Of('x');
  assert.equal(
    objectKeyFor({ objectPrefix: 'p/v1', projectId: 'game-a' }, sha256),
    `p/v1/projects/game-a/sources/sha256/${sha256}`,
  );
  assert.notEqual(
    objectKeyFor({ objectPrefix: 'p/v1', projectId: 'game-b' }, sha256),
    objectKeyFor({ objectPrefix: 'p/v1', projectId: 'game-a' }, sha256),
  );
});
