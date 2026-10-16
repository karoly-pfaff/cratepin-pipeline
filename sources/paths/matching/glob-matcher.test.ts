import assert from 'node:assert/strict';
import test from 'node:test';

import { compileGlob, isUsableGlob } from './glob-matcher.ts';

function assertMatches(glob: string, matching: readonly string[], other: readonly string[]): void {
  const matches = compileGlob(glob);
  for (const path of matching) assert.ok(matches(path), `${glob} should match ${path}`);
  for (const path of other) assert.ok(!matches(path), `${glob} should not match ${path}`);
}

test('** spans zero or more whole segments, * and ? stay inside one segment', () => {
  assertMatches('**/*.png', ['a.png', 'x/a.png', 'x/y/z/a.png'], ['a.pngx', 'a.gif', 'x/png']);
  assertMatches(
    '**/voice/**',
    ['voice/a.mp3', 'x/voice/en/a.mp3'],
    ['voices/a.mp3', 'x/voices/a.mp3'],
  );
  assertMatches('images/*', ['images/a.png'], ['images/x/a.png', 'a.png']);
  assertMatches('a?.png', ['ab.png'], ['a.png', 'abc.png', 'a/.png']);
  assertMatches('a/**/b/**/c.png', ['a/b/c.png', 'a/x/b/y/z/c.png'], ['a/c.png', 'b/c.png']);
});

test('braces, classes and negated classes work; regexp syntax in names is literal', () => {
  assertMatches('**/*.{png,gif}', ['a.png', 'x/a.gif'], ['a.jpg']);
  assertMatches('{a,b/{c,d}}.png', ['a.png', 'b/c.png', 'b/d.png'], ['b/e.png']);
  assertMatches('[a-c]x.png', ['bx.png'], ['dx.png']);
  assertMatches('[!a]x.png', ['bx.png'], ['ax.png']);
  assertMatches('[^a]x.png', ['bx.png'], ['ax.png']);
  assertMatches('[!].png', ['!.png'], ['a.png']);
  assertMatches('a[.png', ['a[.png'], ['a.png']);
  assertMatches('a(1)+$.png', ['a(1)+$.png'], ['a1.png', 'a(1)$.png']);
  assertMatches('a^b|c.png', ['a^b|c.png'], ['c.png']);
});

test('matching ignores letter case and Unicode normalization on every platform', () => {
  assertMatches('**/*.png', ['HERO.PNG', 'Images/Hero.Png'], []);
  assertMatches('Voice/**', ['voice/a.mp3'], []);
  assertMatches('café/*', ['café/a.png', 'CAFÉ/a.png'], ['cafe/a.png']);
});

test('many ** segments still match in linear time', () => {
  const matches = compileGlob(`${'**/'.repeat(30)}x.png`);
  const deepPath = `${'d/'.repeat(2000)}y.png`;
  const startedAt = performance.now();
  assert.ok(!matches(deepPath));
  assert.ok(performance.now() - startedAt < 1000);
});

test('an invalid glob is a programming error, never a silent non-match', () => {
  assert.throws(() => compileGlob('{a,b'), /validated/);
});

test('a glob whose class cannot compile is not usable; letter case does not reverse ranges', () => {
  assert.ok(!isUsableGlob('**/[b-a].png'));
  assert.ok(!isUsableGlob('../**/*.png'));
  assert.ok(isUsableGlob('[Z-a].png'));
  assertMatches('[Z-a].png', ['Z.png', 'a.png', '_.png'], ['b.png']);
});

test('case folding maps one character to one, so ? still matches a sharp s', () => {
  assertMatches('?.png', ['ß.png', 'ẞ.png'], ['ss.png']);
  assertMatches('straße.png', ['STRAẞE.PNG'], ['strasse.png']);
});

test('segment predicates consume whole Unicode code points with simple case folding', () => {
  assertMatches('𐐀?.png', ['𐐨🌲.PNG'], ['𐐨.png', '𐐨ab.png']);
  assertMatches('[𐐀-𐐁]*é.png', ['𐐨café.png', '𐐩É.PNG'], ['𐐪é.png']);
  assertMatches('{𐐀,🌲}*.png', ['𐐨.png', '🌲forest.png'], ['x.png']);
});
