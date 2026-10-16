import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultConfig } from '../config/pipeline-config.ts';
import { objectKeyFor } from '../lock/source-lock.ts';
import { planRemoteRetention } from './cleanup-plan.ts';
import type { RemoteRetentionRequest, RetainedRelease, RetentionObject } from './types.ts';

function namespaceOf(projectId: string): RetainedRelease['namespace'] {
  const config = defaultConfig();
  return { objectPrefix: config.objectPrefix, projectId, limits: config.limits };
}

function releaseOf(
  projectId: string,
  assets: readonly { hash: string; bytes: number }[],
): RetainedRelease {
  const namespace = namespaceOf(projectId);
  return {
    reference: 'release/' + assets.map((asset) => asset.hash).join('-'),
    namespace,
    lock: {
      schemaVersion: 1,
      projectId,
      assets: assets.map(({ hash, bytes }) => ({
        id: hash,
        source: `${hash}.png`,
        sha256: hash.repeat(64),
        bytes,
        mediaType: 'image/png',
        category: 'image',
        objectKey: objectKeyFor(namespace, hash.repeat(64)),
      })),
    },
  };
}

function objectOf(
  projectId: string,
  entry: { hash: string; bytes: number; time?: number },
): RetentionObject {
  return {
    key: objectKeyFor(namespaceOf(projectId), entry.hash.repeat(64)),
    bytes: entry.bytes,
    lastModifiedMs: entry.time ?? 0,
  };
}

function requestOf(): RemoteRetentionRequest {
  return {
    releases: [
      releaseOf('first', [
        { hash: 'a', bytes: 5 },
        { hash: 'b', bytes: 6 },
      ]),
      releaseOf('first', [
        { hash: 'c', bytes: 7 },
        { hash: 'b', bytes: 6 },
      ]),
      releaseOf('second', [{ hash: 'b', bytes: 6 }]),
    ],
    objects: [
      objectOf('first', { hash: 'f', bytes: 4 }),
      objectOf('first', { hash: 'a', bytes: 5 }),
      objectOf('second', { hash: 'b', bytes: 6 }),
      objectOf('first', { hash: 'e', bytes: 10, time: 95000 }),
      objectOf('first', { hash: 'd', bytes: 9 }),
      objectOf('first', { hash: 'b', bytes: 6 }),
      objectOf('first', { hash: 'c', bytes: 7, time: 95000 }),
    ],
    isInventoryComplete: true,
    isReleaseCatalogComplete: true,
    hasVerifiedIndependentBackup: true,
    backupReference: 'offline-backup/verified-release-archive',
    capturedAtMs: 100000,
    nowMs: 100001,
    gracePeriodSeconds: 10,
  };
}

function firstObjectOf(request: RemoteRetentionRequest): RetentionObject {
  const object = request.objects[0];
  assert.ok(object);
  return object;
}
function firstReleaseOf(request: RemoteRetentionRequest): RetainedRelease {
  const release = request.releases[0];
  assert.ok(release);
  return release;
}

test('a dry-run plan retains shared/old release roots across projects and reports only aged orphans without mutation', () => {
  const request = requestOf();
  const before = structuredClone(request);
  const plan = planRemoteRetention(request);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.isReadOnly, true);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(
    plan.candidates.map((object) => object.key),
    ['d', 'f'].map((hash) => objectOf('first', { hash, bytes: 0 }).key),
  );
  assert.equal(plan.candidateBytes, 13);
  assert.equal(plan.referencedCount, 4);
  assert.equal(plan.graceRetainedCount, 1);
  assert.deepEqual(request, before);
  assert.notEqual(
    plan.candidates[0],
    request.objects.find((object) => object.key === plan.candidates[0]?.key),
  );
});

test('incomplete knowledge, unverified backups, unsafe times/grace and oversized snapshots block every candidate', () => {
  const baseline = requestOf();
  const changes = [
    { isInventoryComplete: false },
    { isReleaseCatalogComplete: false },
    { hasVerifiedIndependentBackup: false },
    { backupReference: ' ' },
    { nowMs: NaN },
    { capturedAtMs: -1 },
    { nowMs: 99999 },
    { nowMs: baseline.capturedAtMs + 86400001 },
    { gracePeriodSeconds: 0 },
    { gracePeriodSeconds: 0.5 },
    { gracePeriodSeconds: NaN },
    { gracePeriodSeconds: 31536001 },
    { releases: [] },
    {
      releases: [
        {
          ...firstReleaseOf(baseline),
          lock: { assets: Array.from({ length: 100001 }, () => null) },
        },
      ],
    },
    { objects: Array.from({ length: 100001 }, () => firstObjectOf(baseline)) },
    { releases: Array.from({ length: 1025 }, () => firstReleaseOf(baseline)) },
  ];
  for (const change of changes) {
    const plan = planRemoteRetention({ ...baseline, ...change });
    assert.equal(plan.status, 'blocked');
    assert.ok(plan.blockers.length > 0);
    assert.deepEqual(plan.candidates, []);
    assert.equal(plan.candidateBytes, 0);
  }
});

test('unknown projects, malformed keys, duplicate inventory entries and unverified referenced objects fail closed', () => {
  const baseline = requestOf();
  const invalidObjects = [
    objectOf('unknown', { hash: 'a', bytes: 5 }),
    { ...firstObjectOf(baseline), key: 'not-a-source-key' },
    { ...firstObjectOf(baseline), key: firstObjectOf(baseline).key.toUpperCase() },
    { ...firstObjectOf(baseline), bytes: -1 },
    { ...firstObjectOf(baseline), bytes: NaN },
    { ...firstObjectOf(baseline), bytes: 0.5 },
    { ...firstObjectOf(baseline), lastModifiedMs: 100001 },
    { ...firstObjectOf(baseline), lastModifiedMs: -1 },
  ];
  for (const object of invalidObjects)
    assert.deepEqual(
      planRemoteRetention({ ...baseline, objects: [...baseline.objects, object] }).blockers,
      ['INVALID_INVENTORY_OBJECT'],
    );
  assert.deepEqual(
    planRemoteRetention({ ...baseline, objects: [...baseline.objects, firstObjectOf(baseline)] })
      .blockers,
    ['DUPLICATE_INVENTORY_KEY'],
  );
  assert.deepEqual(
    planRemoteRetention({
      ...baseline,
      objects: baseline.objects.filter(
        (object) => object.key !== objectOf('first', { hash: 'a', bytes: 5 }).key,
      ),
    }).blockers,
    ['REFERENCED_OBJECT_UNVERIFIED'],
  );
  assert.deepEqual(
    planRemoteRetention({
      ...baseline,
      objects: baseline.objects.map((object) =>
        object.key === objectOf('first', { hash: 'a', bytes: 5 }).key
          ? { ...object, bytes: 99 }
          : object,
      ),
    }).blockers,
    ['REFERENCED_OBJECT_UNVERIFIED'],
  );
});

test('invalid or contradictory release locks and unsafe byte totals never produce a partial deletion plan', () => {
  const baseline = requestOf();
  const invalidReleases = [
    { ...firstReleaseOf(baseline), reference: '' },
    { ...firstReleaseOf(baseline), lock: { schemaVersion: 2 } },
    {
      ...firstReleaseOf(baseline),
      namespace: { ...namespaceOf('first'), objectPrefix: '../unsafe' },
    },
    { ...firstReleaseOf(baseline), namespace: namespaceOf('wrong-project') },
  ];
  for (const release of invalidReleases)
    assert.deepEqual(planRemoteRetention({ ...baseline, releases: [release] }).blockers, [
      'INVALID_RELEASE_LOCK',
    ]);
  const conflicting = releaseOf('first', [{ hash: 'a', bytes: 99 }]);
  assert.deepEqual(
    planRemoteRetention({ ...baseline, releases: [...baseline.releases, conflicting] }).blockers,
    ['CONFLICTING_RELEASE_BYTES'],
  );
  const huge = objectOf('first', { hash: '9', bytes: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(
    planRemoteRetention({ ...baseline, objects: [...baseline.objects, huge] }).blockers,
    ['BYTE_TOTAL_UNSAFE'],
  );
});

test('grace is measured conservatively at snapshot capture, with an inclusive boundary and no last-minute promotion', () => {
  const baseline = requestOf();
  const objects = [
    ...baseline.objects,
    objectOf('first', { hash: '8', bytes: 1, time: 90000 }),
    objectOf('first', { hash: '7', bytes: 1, time: 90001 }),
  ];
  const plan = planRemoteRetention({ ...baseline, objects, nowMs: 110000 });
  assert.equal(
    plan.candidates.some((object) => object.key === objectOf('first', { hash: '8', bytes: 1 }).key),
    true,
  );
  assert.equal(
    plan.candidates.some((object) => object.key === objectOf('first', { hash: '7', bytes: 1 }).key),
    false,
  );
});
