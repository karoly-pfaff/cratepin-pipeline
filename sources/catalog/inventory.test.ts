import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { PipelineError } from '../errors.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import { linkDirectory, withWorkspace } from '../paths/layout/layout-fixtures.test-support.ts';
import { caseCollisionIssues, inventorySources } from './inventory.ts';
import type { SourceInventory } from './inventory.ts';
import { isBlockingIssue } from './source-issues.ts';
import { hashOpenedWithinLimit } from './source-reading.ts';
import {
  canDenyAccess,
  checkedProjectIn,
  sha256Of,
  withReadDenied,
  writeFiles,
  writeSources,
} from './source-fixtures.test-support.ts';

const MIXED_MEDIA = {
  'images/cat.png': 'cat png bytes',
  'images/ui/Button.JPG': 'button jpeg bytes',
  'scenes/forest/voice/en/hello.mp3': 'hello voice bytes',
  'scenes/forest/effects/drop.ogg': 'drop effect bytes',
  'music/theme.wav': 'theme music bytes',
  'fonts/title.woff2': 'font bytes',
};

function issueSummary(inventory: SourceInventory): string[] {
  return inventory.issues.map((issue) => `${issue.code} ${issue.path}`);
}

function blockingIssueSummary(inventory: SourceInventory): string[] {
  return issueSummary({ ...inventory, issues: inventory.issues.filter(isBlockingIssue) });
}

/** The inventory taken while the content of `paths` cannot be read. */
function inventoryWhileUnreadable(
  project: CheckedProject,
  paths: readonly string[],
): Promise<SourceInventory> {
  return withReadDenied(paths, () => inventorySources(project));
}

function entryPaths(inventory: SourceInventory): string[] {
  return inventory.entries.map((found) => found.path);
}

function mixedMediaEntry(
  path: keyof typeof MIXED_MEDIA,
  mediaType: string,
  category: string,
): object {
  const content = MIXED_MEDIA[path];
  return { path, sha256: sha256Of(content), bytes: content.length, mediaType, category };
}

test('a mixed media tree yields a sorted inventory with hashes, sizes, types and categories', async () => {
  await withWorkspace(async (workspace) => {
    await writeSources(workspace, { ...MIXED_MEDIA, 'notes.txt': 'not a selected format' });
    const project = await checkedProjectIn(workspace, {
      sources: {
        include: ['**/*.{png,jpg,mp3,ogg,wav,woff2}'],
        categories: [
          { match: '**/voice/**', category: 'voice' },
          { match: '**/effects/**', category: 'effects' },
          { match: 'music/**', category: 'music' },
          { match: '**/*.{png,jpg}', category: 'image' },
        ],
      },
    });
    const inventory = await inventorySources(project);
    assert.deepEqual(inventory.issues, []);
    assert.deepEqual(inventory.entries, [
      mixedMediaEntry('fonts/title.woff2', 'font/woff2', 'other'),
      mixedMediaEntry('images/cat.png', 'image/png', 'image'),
      mixedMediaEntry('images/ui/Button.JPG', 'image/jpeg', 'image'),
      mixedMediaEntry('music/theme.wav', 'audio/wav', 'music'),
      mixedMediaEntry('scenes/forest/effects/drop.ogg', 'audio/ogg', 'effects'),
      mixedMediaEntry('scenes/forest/voice/en/hello.mp3', 'audio/mpeg', 'voice'),
    ]);
  });
});

test('hidden files are never listed, even when a pattern would select them', async () => {
  await withWorkspace(async (workspace) => {
    await writeSources(workspace, {
      'images/cat.png': 'cat',
      '.env': 'R2_WRITE_SECRET_ACCESS_KEY=do-not-read',
      '.git/config.json': '{}',
      'images/.cache/thumb.png': 'thumb',
      'secrets.txt': 'selected but unsupported, so never read',
    });
    const project = await checkedProjectIn(workspace, { sources: { include: ['**/*', '.*'] } });
    const inventory = await inventorySources(project);
    assert.deepEqual(entryPaths(inventory), ['images/cat.png']);
    assert.deepEqual(issueSummary(inventory), [
      'UNMATCHED_PATTERN /sources/include/1',
      'UNSUPPORTED_MEDIA secrets.txt',
    ]);
  });
});

test('unsupported formats, unsuitable categories and unportable names have stable codes', async () => {
  await withWorkspace(async (workspace) => {
    await writeSources(workspace, {
      'images/photo.bmp': 'bitmap',
      'voice/en/portrait.png': 'png among voice lines',
      'images/GENERA~1.png': 'an 8.3-looking name',
      'images/noextension': 'no extension',
    });
    const project = await checkedProjectIn(workspace, { sources: { include: ['**/*'] } });
    const inventory = await inventorySources(project);
    assert.deepEqual(inventory.entries, []);
    assert.deepEqual(issueSummary(inventory), [
      'UNPORTABLE_PATH images/GENERA~1.png',
      'UNSUPPORTED_MEDIA images/noextension',
      'UNSUPPORTED_MEDIA images/photo.bmp',
      'CATEGORY_MISMATCH voice/en/portrait.png',
    ]);
    assert.ok(inventory.issues.every(isBlockingIssue));
  });
});

test('identical bytes and unused patterns are notices, not blocking issues', async () => {
  await withWorkspace(async (workspace) => {
    await writeSources(workspace, { 'a/drop.mp3': 'same', 'b/drop.mp3': 'same' });
    const project = await checkedProjectIn(workspace, {
      sources: { include: ['**/*.mp3', '**/*.flac'] },
    });
    const inventory = await inventorySources(project);
    assert.deepEqual(entryPaths(inventory), ['a/drop.mp3', 'b/drop.mp3']);
    assert.deepEqual(issueSummary(inventory), [
      'UNMATCHED_PATTERN /sources/include/1',
      'DUPLICATE_CONTENT a/drop.mp3',
      'DUPLICATE_CONTENT b/drop.mp3',
    ]);
    assert.ok(!inventory.issues.some(isBlockingIssue));
    assert.match(inventory.issues[1]?.message ?? '', /a\/drop\.mp3, b\/drop\.mp3/);
  });
});

test('names differing only in Unicode form are reported as collisions', async (context) => {
  await withWorkspace(async (workspace) => {
    const sourceRoot = await writeSources(workspace, {
      'images/café.png': 'composed',
      'images/café.png': 'decomposed',
    });
    if ((await readdir(join(sourceRoot, 'images'))).length < 2) {
      context.skip('this file system merges Unicode forms, so no collision can exist on disk');
      return;
    }
    const inventory = await inventorySources(await checkedProjectIn(workspace));
    assert.deepEqual(blockingIssueSummary(inventory), [
      'CASE_COLLISION images/café.png',
      'CASE_COLLISION images/café.png',
    ]);
  });
});

test('links inside the source tree are reported and never followed', async () => {
  await withWorkspace(async (workspace) => {
    const sourceRoot = await writeSources(workspace, { 'images/cat.png': 'cat' });
    const outside = await writeFiles(join(workspace, 'outside'), { 'private.png': 'outside' });
    await linkDirectory(outside, join(sourceRoot, 'linked'));
    const inventory = await inventorySources(await checkedProjectIn(workspace));
    assert.deepEqual(entryPaths(inventory), ['images/cat.png']);
    assert.deepEqual(blockingIssueSummary(inventory), ['NOT_A_REGULAR_FILE linked']);
  });
});

test('originals over the size limit are refused before they are opened', async (context) => {
  if (!canDenyAccess()) {
    context.skip('a root process can read every file');
    return;
  }
  await withWorkspace(async (workspace) => {
    const sourceRoot = await writeSources(workspace, {
      'music/small.mp3': 'small',
      'music/huge.mp3': new Uint8Array(2048),
    });
    const project = await checkedProjectIn(workspace, { limits: { maxSourceBytes: 1024 } });
    // Reading the oversized file would fail, so SOURCE_TOO_LARGE proves it was never opened.
    const inventory = await inventoryWhileUnreadable(project, [
      join(sourceRoot, 'music', 'huge.mp3'),
    ]);
    assert.deepEqual(blockingIssueSummary(inventory), ['SOURCE_TOO_LARGE music/huge.mp3']);
    assert.deepEqual(entryPaths(inventory), ['music/small.mp3']);
  });
});

test('unreadable files and directories are issues naming their path, not a failed scan', async (context) => {
  if (!canDenyAccess()) {
    context.skip('a root process can read every file');
    return;
  }
  await withWorkspace(async (workspace) => {
    const sourceRoot = await writeSources(workspace, {
      'images/a.png': 'a',
      'images/locked.png': 'locked',
      'voice/en/hi.mp3': 'hi',
    });
    const project = await checkedProjectIn(workspace);
    const locked = [join(sourceRoot, 'images', 'locked.png'), join(sourceRoot, 'voice', 'en')];
    const inventory = await inventoryWhileUnreadable(project, locked);
    assert.deepEqual(entryPaths(inventory), ['images/a.png']);
    const unreadable = inventory.issues.filter(isBlockingIssue);
    assert.deepEqual(issueSummary({ ...inventory, issues: unreadable }), [
      'UNREADABLE_SOURCE images/locked.png',
      'UNREADABLE_SOURCE voice/en',
    ]);
    for (const issue of unreadable) assert.match(issue.message, /System code: E[A-Z]+\./);
  });
});

test('paths differing only in letter case collide, naming every member', () => {
  const issues = caseCollisionIssues([
    'images/Hero.png',
    'b.png',
    'images/hero.PNG',
    'IMAGES/HERO.png',
  ]);
  assert.deepEqual(
    issues.map((issue) => `${issue.code} ${issue.path}`),
    [
      'CASE_COLLISION IMAGES/HERO.png',
      'CASE_COLLISION images/Hero.png',
      'CASE_COLLISION images/hero.PNG',
    ],
  );
  assert.match(
    issues[0]?.message ?? '',
    /Group: IMAGES\/HERO\.png, images\/Hero\.png, images\/hero\.PNG\./,
  );
});

test('a large original is hashed as a stream with the exact byte count', async () => {
  await withWorkspace(async (workspace) => {
    const chunk = new Uint8Array(1024 * 1024).fill(7);
    const chunkCount = 48;
    const sourceRoot = await writeSources(workspace, {});
    const file = await open(join(sourceRoot, 'large.png'), 'w');
    const expected = createHash('sha256');
    for (let index = 0; index < chunkCount; index += 1) {
      await file.write(chunk);
      expected.update(chunk);
    }
    await file.close();
    const inventory = await inventorySources(await checkedProjectIn(workspace));
    assert.deepEqual(inventory.entries, [
      {
        path: 'large.png',
        sha256: expected.digest('hex'),
        bytes: chunk.length * chunkCount,
        mediaType: 'image/png',
        category: 'image',
      },
    ]);
  });
});

function isNotFoundError(error: unknown): boolean {
  return error instanceof PipelineError && error.code === 'NOT_FOUND';
}

test('a missing source directory fails with NOT_FOUND', async () => {
  await withWorkspace(async (workspace) => {
    const project = await checkedProjectIn(workspace);
    await assert.rejects(inventorySources(project), isNotFoundError);
  });
});

test('an opened file that grew past the limit is refused after reading one byte too many', async () => {
  await withWorkspace(async (workspace) => {
    const sourceRoot = await writeSources(workspace, { 'music/grown.mp3': new Uint8Array(4096) });
    const file = await open(join(sourceRoot, 'music', 'grown.mp3'));
    try {
      const candidate = {
        path: 'music/grown.mp3',
        mediaType: 'audio/mpeg',
        category: 'music',
      } as const;
      const result = await hashOpenedWithinLimit(file, candidate, 1024);
      assert.ok('rejected' in result && result.rejected.code === 'SOURCE_TOO_LARGE');
    } finally {
      await file.close();
    }
  });
});
