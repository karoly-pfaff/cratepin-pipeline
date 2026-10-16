import assert from 'node:assert/strict';
import { link, mkdir, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import test from 'node:test';

import { linkDirectory, withWorkspace } from './layout/layout-fixtures.test-support.ts';
import {
  couldContainOnAnyPlatform,
  couldOverlapOnAnyPlatform,
  entryKindAt,
  fileIdentityOf,
  isRealPathSameOrInside,
  resolveRealLocation,
} from './path-containment.ts';

test('real-path containment accepts the root and descendants, rejects siblings and parents', () => {
  const root = join(sep, 'workspace', 'game');
  assert.ok(isRealPathSameOrInside(root, root));
  assert.ok(isRealPathSameOrInside(root, join(root, 'assets', 'cat.png')));
  assert.ok(!isRealPathSameOrInside(root, join(sep, 'workspace', 'game-other')));
  assert.ok(!isRealPathSameOrInside(root, join(sep, 'workspace')));
  assert.ok(isRealPathSameOrInside(sep, join(sep, 'anything')));
});

test('real-path containment never folds case or Unicode forms', () => {
  const kelvinProject = join(sep, 'workspace', 'Kproj');
  assert.ok(!isRealPathSameOrInside(kelvinProject, join(sep, 'workspace', 'kproj', 'out')));
  assert.ok(!isRealPathSameOrInside(join(sep, 'café'), join(sep, 'café', 'out')));
  assert.ok(!isRealPathSameOrInside(join(sep, 'Game'), join(sep, 'game', 'out')));
});

test('overlap and containment for policy checks ignore letter case and direction', () => {
  const workspace = join('workspace', 'game');
  assert.ok(couldOverlapOnAnyPlatform(join(workspace, 'Media'), join(workspace, 'media', 'cache')));
  assert.ok(couldOverlapOnAnyPlatform(join(workspace, 'media', 'cache'), join(workspace, 'MEDIA')));
  assert.ok(!couldOverlapOnAnyPlatform(join(workspace, 'media'), join(workspace, 'media-cache')));
  assert.ok(couldContainOnAnyPlatform('assets', join('Assets', 'source')));
  assert.ok(!couldContainOnAnyPlatform(join('assets', 'source'), 'assets'));
});

test('real locations resolve links in any ancestor, including not-yet-existing tails', async () => {
  await withWorkspace(async (workspace) => {
    const outside = join(workspace, 'outside');
    await mkdir(outside);
    await mkdir(join(workspace, 'project'));
    await linkDirectory(outside, join(workspace, 'project', 'linked'));
    const throughLink = join(workspace, 'project', 'linked', 'not', 'created', 'yet');
    assert.equal(await resolveRealLocation(throughLink), join(outside, 'not', 'created', 'yet'));
  });
});

test('entry kinds distinguish absent paths, directories, files and links', async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(join(workspace, 'directory'));
    await writeFile(join(workspace, 'file.txt'), 'x');
    await linkDirectory(join(workspace, 'directory'), join(workspace, 'link'));
    assert.equal(await entryKindAt(join(workspace, 'missing')), 'absent');
    assert.equal(await entryKindAt(join(workspace, 'file.txt', 'below-a-file')), 'absent');
    assert.equal(await entryKindAt(join(workspace, 'directory')), 'directory');
    assert.equal(await entryKindAt(join(workspace, 'file.txt')), 'file');
    assert.equal(await entryKindAt(join(workspace, 'link')), 'symbolic-link');
  });
});

test('hard links share one file identity; distinct files and missing paths do not', async () => {
  await withWorkspace(async (workspace) => {
    const original = join(workspace, 'config.json');
    await writeFile(original, '{}');
    await link(original, join(workspace, 'hard-link.json'));
    await writeFile(join(workspace, 'other.json'), '{}');
    const originalIdentity = await fileIdentityOf(original);
    assert.ok(originalIdentity !== undefined);
    assert.equal(await fileIdentityOf(join(workspace, 'hard-link.json')), originalIdentity);
    assert.notEqual(await fileIdentityOf(join(workspace, 'other.json')), originalIdentity);
    assert.equal(await fileIdentityOf(join(workspace, 'missing.json')), undefined);
  });
});

test('an entry that cannot be inspected is unreadable, never absent, and stops resolution', async () => {
  await withWorkspace(async (workspace) => {
    const uninspectable = join(workspace, 'nul\u0000byte');
    assert.equal(await entryKindAt(uninspectable), 'unreadable');
    await assert.rejects(resolveRealLocation(join(uninspectable, 'child')), { code: 'IO_FAILED' });
  });
});
