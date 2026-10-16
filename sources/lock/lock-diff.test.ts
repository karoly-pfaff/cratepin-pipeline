import assert from 'node:assert/strict';
import test from 'node:test';

import { compareCodeUnits } from '../catalog/ordering.ts';
import { sha256Of } from '../catalog/source-fixtures.test-support.ts';
import { diffLocks } from './lock-diff.ts';
import { objectKeyFor } from './source-lock.ts';
import type { SourceLock, SourceRecord } from './source-lock.ts';
import { planUploads, totalBytes } from './upload-plan.ts';

const NAMESPACE = { objectPrefix: 'cratepin/v1', projectId: 'demo' };

/** A record for `<id>.png` holding `content`. */
function record(id: string, content: string, extra: Partial<SourceRecord> = {}): SourceRecord {
  const sha256 = sha256Of(content);
  return {
    id,
    source: `${id}.png`,
    sha256,
    bytes: content.length,
    mediaType: 'image/png',
    category: 'image',
    objectKey: objectKeyFor(NAMESPACE, sha256),
    ...extra,
  };
}

function lockOf(...assets: SourceRecord[]): SourceLock {
  return { schemaVersion: 1, projectId: 'demo', assets };
}

const COMMITTED = lockOf(
  record('images/cat', 'cat'),
  record('images/dog', 'dog'),
  record('voice/hi', 'hi', { locale: 'en' }),
  record('images/sun', 'sun'),
);

const STAGED = lockOf(
  record('images/kitty', 'cat'),
  record('voice/hi', 'hello', { locale: 'hu' }),
  record('images/sun', 'sun'),
  record('images/bird', 'bird'),
);

function ids(records: readonly SourceRecord[]): string[] {
  return records.map((changedRecord) => changedRecord.id);
}

test('two locks differ by added, changed, unchanged and removed IDs', () => {
  const diff = diffLocks(COMMITTED, STAGED);
  assert.deepEqual(ids(diff.added), ['images/kitty', 'images/bird']);
  assert.deepEqual(ids(diff.unchanged), ['images/sun']);
  assert.deepEqual(ids(diff.removed), ['images/cat', 'images/dog']);
  assert.deepEqual(
    diff.changed.map(({ after, changedFields }) => [after.id, changedFields]),
    [['voice/hi', ['sha256', 'bytes', 'objectKey', 'locale']]],
  );
});

test('a rename with the same bytes is reported as an identity change, not new content', () => {
  const diff = diffLocks(COMMITTED, STAGED);
  assert.deepEqual(
    diff.identityChanges.map(({ from, to }) => [from.id, to.id, to.sha256]),
    [['images/cat', 'images/kitty', sha256Of('cat')]],
  );
  const plan = planUploads(COMMITTED, STAGED);
  assert.ok(!plan.toUpload.some((object) => object.sha256 === sha256Of('cat')));
});

test('without a committed lock everything is added and must be uploaded', () => {
  const diff = diffLocks(undefined, STAGED);
  assert.deepEqual(ids(diff.added), ids(STAGED.assets));
  assert.deepEqual(diff.removed, []);
  const plan = planUploads(undefined, STAGED);
  assert.equal(plan.toUpload.length, 4);
  assert.equal(
    totalBytes(plan.toUpload),
    'cat'.length + 'hello'.length + 'sun'.length + 'bird'.length,
  );
});

test('the upload plan counts bytes per stored object and keeps unreferenced objects', () => {
  const plan = planUploads(COMMITTED, STAGED);
  const uploads = plan.toUpload.map((object) => `${object.ids.join(',')} ${String(object.bytes)}`);
  assert.deepEqual(uploads.toSorted(compareCodeUnits), ['images/bird 4', 'voice/hi 5']);
  const uploadKeys = plan.toUpload.map((object) => object.objectKey);
  assert.deepEqual(uploadKeys, uploadKeys.toSorted(compareCodeUnits));
  const alreadyLockedIds = plan.alreadyLocked.map((object) => object.ids.join(','));
  assert.deepEqual(alreadyLockedIds.toSorted(compareCodeUnits), ['images/kitty', 'images/sun']);
  assert.equal(totalBytes(plan.keptUnreferenced), 'dog'.length + 'hi'.length);
});

test('IDs sharing bytes share one planned object', () => {
  const staged = lockOf(record('a', 'same'), record('b', 'same'));
  const plan = planUploads(undefined, staged);
  assert.deepEqual(
    plan.toUpload.map((object) => object.ids),
    [['a', 'b']],
  );
  assert.equal(totalBytes(plan.toUpload), 4);
});
