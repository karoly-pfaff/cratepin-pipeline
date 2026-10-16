import assert from 'node:assert/strict';
import test from 'node:test';

import {
  caseFoldedPath,
  hasProtectedDirectorySegment,
  isPortableRelativeGlob,
  isPortableRelativePath,
} from './portable-path.ts';

/** Unsafe on at least one platform: traversal, absolute/drive/UNC forms, separators, streams. */
const UNSAFE_SHAPES = [
  '../x',
  'a/../x',
  'C:/x',
  '/x',
  '//server/share',
  'a\\b',
  'a//b',
  'a:ads',
  'a/./b',
  'a\u0001b',
  '',
];
/** Names Windows reserves or silently changes. */
const WINDOWS_TRAPS = [
  'CON',
  'con.txt',
  'a/nul',
  'COM1.png',
  'lpt9',
  'aux/x',
  'a/b.',
  'a /b',
  'trailing ',
];
const SAFE_LOOKALIKES = ['console.png', 'icon', 'CONFIG', 'comet/LPT', 'auxiliary', 'a.b/c'];

test('portable relative paths reject traversal, drives, UNC, separators and reserved characters', () => {
  for (const unsafePath of UNSAFE_SHAPES)
    assert.equal(isPortableRelativePath(unsafePath), false, unsafePath);
  assert.equal(isPortableRelativePath('assets/source'), true);
  assert.equal(isPortableRelativePath('images/*.png'), false);
});

test('Windows device names and trimmed endings are rejected; look-alikes are allowed', () => {
  for (const trap of WINDOWS_TRAPS) {
    assert.equal(isPortableRelativePath(trap), false, trap);
    assert.equal(isPortableRelativeGlob(trap), false, trap);
  }
  for (const lookalike of SAFE_LOOKALIKES)
    assert.equal(isPortableRelativePath(lookalike), true, lookalike);
});

test('portable globs allow wildcards but keep every other path rule', () => {
  for (const unsafeGlob of UNSAFE_SHAPES)
    assert.equal(isPortableRelativeGlob(unsafeGlob), false, unsafeGlob);
  assert.equal(isPortableRelativeGlob('scenes/*/images/{characters,objects}/**/*.png'), true);
});

test('case folding treats differently cased and composed forms as one path', () => {
  assert.equal(caseFoldedPath('Assets/Ünnep'), caseFoldedPath('assets/u\u0308nnep'));
  assert.notEqual(caseFoldedPath('assets/a'), caseFoldedPath('assets/b'));
  assert.equal(caseFoldedPath('\u1e9e.png'), caseFoldedPath('\u00df.png'));
  assert.equal(caseFoldedPath('\u00df.png'), caseFoldedPath('SS.png'));
});

test('brace alternatives are checked one by one, so braces cannot smuggle in traversal', () => {
  for (const escaping of [
    '{..,x}/**/*.png',
    '{/etc,a}/*',
    'a/{b,..}/c',
    '{con,a}/x',
    'a/{b',
    'a}/b',
  ]) {
    assert.equal(isPortableRelativeGlob(escaping), false, escaping);
  }
  for (const portable of ['**/*.{png,gif}', 'a/{b,{c,d}}/*']) {
    assert.equal(isPortableRelativeGlob(portable), true, portable);
  }
});

test('negation and runaway brace expansion are rejected', () => {
  assert.equal(isPortableRelativeGlob('!**/*.png'), false);
  const startedAt = Date.now();
  assert.equal(isPortableRelativeGlob('{a,b}'.repeat(40)), false);
  assert.ok(Date.now() - startedAt < 1_000);
});

test('character classes cannot spell a dot segment, but ordinary classes stay usable', () => {
  for (const escaping of ['[.][.]/x/*.png', '.[.]/x/*.png', 'a/[.]/b']) {
    assert.equal(isPortableRelativeGlob(escaping), false, escaping);
  }
  for (const portable of ['[ab]c/*.png', '**/*.[pP][nN][gG]']) {
    assert.equal(isPortableRelativeGlob(portable), true, portable);
  }
});

test('thousands of brace groups are rejected without exhausting the stack', () => {
  assert.equal(isPortableRelativeGlob('{a}'.repeat(5000)), false);
  assert.equal(isPortableRelativeGlob(`${'{'.repeat(5000)}a${'}'.repeat(5000)}`), false);
});

test('8.3 short names and protected tool directories are recognized', () => {
  for (const shortName of ['GENERA~1', 'assets/LONGNA~2/x', 'PROGRA~1']) {
    assert.equal(isPortableRelativePath(shortName), false, shortName);
  }
  assert.equal(isPortableRelativePath('assets/tilde~name'), true);
  for (const protectedPath of ['.git/x', 'a/node_modules/b', 'NODE_MODULES', 'x/.SVN']) {
    assert.equal(hasProtectedDirectorySegment(protectedPath), true, protectedPath);
  }
  assert.equal(hasProtectedDirectorySegment('assets/git/modules'), false);
});
