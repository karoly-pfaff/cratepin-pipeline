import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { checkedProjectIn, sha256Of } from '../catalog/source-fixtures.test-support.ts';
import { toPipelineError } from '../errors.ts';
import { withWorkspace } from '../paths/layout/layout-fixtures.test-support.ts';
import { loadCommittedLock } from './lock-file.ts';
import { validateLock } from './lock-validation.ts';
import type { LockValidation } from './lock-validation.ts';
import { objectKeyFor, serializeLock } from './source-lock.ts';
import type { SourceLock, SourceRecord } from './source-lock.ts';

const NAMESPACE = {
  objectPrefix: 'cratepin/v1',
  projectId: 'demo',
  limits: { maxSourceBytes: 1024 },
};

function record(id: string, source: string, extra: Partial<SourceRecord> = {}): SourceRecord {
  const sha256 = extra.sha256 ?? sha256Of(source);
  return {
    id,
    source,
    sha256,
    bytes: 3,
    mediaType: 'image/png',
    category: 'image',
    objectKey: objectKeyFor(NAMESPACE, sha256),
    ...extra,
  };
}

function lockOf(...assets: SourceRecord[]): SourceLock {
  return { schemaVersion: 1, projectId: 'demo', assets };
}

function issuesOf(validation: LockValidation): string[] {
  return validation.ok ? [] : validation.issues.map((issue) => `${issue.code} ${issue.path}`);
}

function issuesOfLockWith(changes: Readonly<Record<string, unknown>>): string[] {
  const changed = { ...record('a', 'a.png'), ...changes };
  return issuesOf(validateLock(lockOf(changed), NAMESPACE));
}

const FULLY_DESCRIBED = record('b', 'b.png', {
  locale: 'en',
  role: 'icon',
  profile: 'thumb',
  licence: 'CC-BY-4.0',
});

test('a hand-ordered lock validates to its records sorted by ID, optional fields kept', () => {
  const unsorted = lockOf(FULLY_DESCRIBED, record('a', 'a.png'));
  const validation = validateLock(JSON.parse(JSON.stringify(unsorted)), NAMESPACE);
  assert.ok(validation.ok);
  assert.deepEqual(validation.lock.assets, [record('a', 'a.png'), FULLY_DESCRIBED]);
});

test('the committed text has one exact, indented layout', () => {
  const sha256 = sha256Of('a.png');
  const expected = [
    '{',
    '  "schemaVersion": 1,',
    '  "projectId": "demo",',
    '  "assets": [',
    '    {',
    '      "id": "a",',
    '      "source": "a.png",',
    `      "sha256": "${sha256}",`,
    '      "bytes": 3,',
    '      "mediaType": "image/png",',
    '      "category": "image",',
    `      "objectKey": "cratepin/v1/projects/demo/sources/sha256/${sha256}",`,
    '      "locale": "en",',
    '      "role": "icon",',
    '      "profile": "thumb",',
    '      "licence": "MIT"',
    '    }',
    '  ]',
    '}',
    '',
  ].join('\n');
  const described = { licence: 'MIT', profile: 'thumb', role: 'icon', locale: 'en' };
  assert.equal(serializeLock(lockOf(record('a', 'a.png', described))), expected);
});

test('a newer schema version is unsupported; a missing or malformed one is invalid', () => {
  const newer = { ...lockOf(record('a', 'a.png')), schemaVersion: 2, newRequiredField: true };
  assert.deepEqual(issuesOf(validateLock(newer, NAMESPACE)), ['LOCK_UNSUPPORTED /schemaVersion']);
  for (const schemaVersion of [undefined, 0, 1.5, '1', null]) {
    const malformed = { ...lockOf(), schemaVersion };
    assert.deepEqual(issuesOf(validateLock(malformed, NAMESPACE)), ['LOCK_INVALID /schemaVersion']);
  }
});

test('an altered hash or object key no longer matches the content-addressed key', () => {
  const keyOfOriginalBytes = objectKeyFor(NAMESPACE, sha256Of('a.png'));
  assert.deepEqual(
    issuesOfLockWith({ sha256: sha256Of('other bytes'), objectKey: keyOfOriginalBytes }),
    ['LOCK_INVALID /assets/0/objectKey'],
  );
  assert.deepEqual(
    issuesOfLockWith({ objectKey: `other-game/sources/sha256/${sha256Of('a.png')}` }),
    ['LOCK_INVALID /assets/0/objectKey'],
  );
});

const INVALID_FIELD_VALUES: readonly (readonly [field: string, value: unknown])[] = [
  ['id', '/abs'],
  ['source', '../a.png'],
  ['sha256', sha256Of('a.png').toUpperCase()],
  ['bytes', -1],
  ['mediaType', ''],
  ['category', 'video'],
  ['objectKey', ''],
  ['locale', 'english'],
  ['role', 'Icon'],
  ['profile', 'Thumb'],
  ['licence', 'two\nlines'],
];

test('every field rule of a record is enforced', () => {
  for (const [field, value] of INVALID_FIELD_VALUES) {
    const issues = issuesOfLockWith({ [field]: value });
    assert.ok(issues.includes(`LOCK_INVALID /assets/0/${field}`), `${field}: ${String(issues)}`);
  }
});

test("another project's lock and unknown top-level fields are refused", () => {
  const foreign = { ...lockOf(record('a', 'a.png')), projectId: 'other-game' };
  assert.deepEqual(issuesOf(validateLock(foreign, NAMESPACE)), ['LOCK_INVALID /projectId']);
  const malformedProject = { ...lockOf(), projectId: 'Not A Slug', generatedAt: 'today' };
  assert.deepEqual(issuesOf(validateLock(malformedProject, NAMESPACE)), [
    'LOCK_INVALID /generatedAt',
    'LOCK_INVALID /projectId',
  ]);
  assert.deepEqual(issuesOf(validateLock([], NAMESPACE)), ['LOCK_INVALID /']);
});

test('duplicates, unsupported extensions and mismatched types are reported by path', () => {
  const duplicates = lockOf(record('a', 'a.png'), record('A', 'b.png'), record('c', 'B.png'));
  assert.deepEqual(issuesOf(validateLock(duplicates, NAMESPACE)), [
    'LOCK_INVALID /assets/1/id',
    'LOCK_INVALID /assets/2/source',
  ]);
  const mismatched = lockOf(
    record('a', 'a.png', { mediaType: 'image/webp' }),
    record('b', 'b.mp3', { mediaType: 'audio/mpeg', category: 'image' }),
    record('c', 'readme.xyz', { mediaType: 'a supported extension', category: 'other' }),
  );
  assert.deepEqual(issuesOf(validateLock(mismatched, NAMESPACE)), [
    'LOCK_INVALID /assets/0/mediaType',
    'LOCK_INVALID /assets/1/category',
    'LOCK_INVALID /assets/2/source',
  ]);
});

function isDirectoryReadError(error: unknown): boolean {
  return toPipelineError(error).code === 'INVALID_DATA';
}

test('the committed lock file is absent, valid or invalid; other read errors propagate', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    assert.deepEqual(await loadCommittedLock(project), { status: 'absent' });
    const lockFile = join(workspace, 'cratepin-lock.json');
    await writeFile(lockFile, serializeLock(lockOf(record('a', 'a.png'))));
    assert.equal((await loadCommittedLock(project)).status, 'valid');
    await writeFile(lockFile, '{"schemaVersion":1,"projectId":"demo","projectId":"x","assets":[]}');
    assert.deepEqual(await loadCommittedLock(project), {
      status: 'invalid',
      issues: [
        {
          path: '/projectId',
          code: 'LOCK_INVALID',
          message: 'Duplicate field; JSON would silently keep only the last value',
        },
      ],
    });
    await writeFile(lockFile, '{ not json');
    assert.equal((await loadCommittedLock(project)).status, 'invalid');
    await rm(lockFile);
    await mkdir(lockFile);
    await assert.rejects(loadCommittedLock(project), isDirectoryReadError);
  });
});

test('a lock written under another objectPrefix is one issue with the way forward', () => {
  const otherPrefix = { objectPrefix: 'assets/v0', projectId: 'demo' };
  const sha256 = sha256Of('a.png');
  const moved = lockOf(record('a', 'a.png', { objectKey: objectKeyFor(otherPrefix, sha256) }));
  const validation = validateLock(moved, NAMESPACE);
  assert.deepEqual(issuesOf(validation), ['LOCK_INVALID /assets']);
  assert.ok(
    !validation.ok && (validation.issues[0]?.message ?? '').includes('move this lock aside'),
  );
});

test('an empty lock is valid; one key under another prefix is a per-record issue', () => {
  assert.ok(validateLock(lockOf(), NAMESPACE).ok);
  const otherPrefix = { objectPrefix: 'assets/v0', projectId: 'demo' };
  const mixed = lockOf(
    record('a', 'a.png', { objectKey: objectKeyFor(otherPrefix, sha256Of('a.png')) }),
    record('b', 'b.png'),
  );
  assert.deepEqual(issuesOf(validateLock(mixed, NAMESPACE)), ['LOCK_INVALID /assets/0/objectKey']);
});

test('a record larger than limits.maxSourceBytes is invalid before anything is retrieved', () => {
  const tooLarge = lockOf(record('ui/huge', 'ui/huge.png', { bytes: 1025 }));
  const atLimit = lockOf(record('ui/large', 'ui/large.png', { bytes: 1024 }));
  assert.deepEqual(issuesOf(validateLock(tooLarge, NAMESPACE)), ['LOCK_INVALID /assets/0/bytes']);
  assert.equal(validateLock(atLimit, NAMESPACE).ok, true);
});
