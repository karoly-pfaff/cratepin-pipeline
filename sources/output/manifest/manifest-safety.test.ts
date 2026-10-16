import assert from 'node:assert/strict';
import test from 'node:test';

import { checkedProjectIn } from '../../catalog/source-fixtures.test-support.ts';
import { withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import { unsafeOutputError, unsafeValueContextOf, unsafeValueIssues } from './manifest-safety.ts';
import type { UnsafeValueContext } from './manifest-safety.ts';

const CONTEXT = { storageAddresses: ['pub-0123.example'] };

function manifestWith(url: string, source = 'app/cat.png'): object {
  return { assets: { 'app/cat': { url, source, sha256: 'a'.repeat(64) } } };
}

function pointersIn(value: unknown, context: UnsafeValueContext): string[] {
  return unsafeValueIssues(value, context).map(({ path }) => path);
}

function flaggedPointers(value: unknown): string[] {
  return unsafeValueIssues(value, CONTEXT).map(({ path }) => path);
}

function isReportedAtUrlWithoutValue(
  issue: { path: string; message: string },
  url: string,
): boolean {
  return issue.path === '/assets/app~1cat/url' && !issue.message.includes(url);
}

test('the values a build writes are safe, also below directories named like a project path', () => {
  const safe = [
    'assets/app/cat.webp',
    'app/ui/button.webp',
    'assets/a%20b%23c.png',
    'generations/0123456789abcdef/x.png',
    'x%3Fsig%3D1.png',
  ];
  for (const url of safe) {
    assert.deepEqual(flaggedPointers(manifestWith(url, 'app/a b#c&sig=1.png')), [], url);
  }
});

test('anything that must not ship is flagged at its pointer, without its value', () => {
  const unsafe = [
    '../outside.png',
    'https://cdn.example/cat.png',
    'assets/cat.png?X-Amz-Signature=abc',
    'assets/cat.png?se=2026&sp=r&sig=abc',
    'C:\\games\\cat.png',
    '\\\\server\\share\\cat.png',
    '/assets/cat.png',
    'assets/cat.png#frag',
    'user@assets/cat.png',
    'pub-0123.example/assets/cat.png',
    'AKIAABCDEFGHIJKLMNOP',
  ];
  for (const url of unsafe) {
    const issues = unsafeValueIssues(manifestWith(url), CONTEXT);
    assert.ok(issues.length > 0, url);
    assert.ok(
      issues.every((issue) => isReportedAtUrlWithoutValue(issue, url)),
      url,
    );
  }
});

test('keys are scanned without being echoed, and a raw query only matters in a URL', () => {
  assert.deepEqual(flaggedPointers({ assets: { '../escape': {} } }), ['/assets/..~1escape#key']);
  assert.deepEqual(flaggedPointers({ assets: { AKIAABCDEFGHIJKLMNOP: {} } }), [
    '/assets/[REDACTED]#key',
  ]);
  assert.deepEqual(flaggedPointers({ source: 'odd?name.png' }), []);
  assert.deepEqual(flaggedPointers({ source: 'odd?X-Amz-Credential=x' }), ['/source']);
});

test('a build is stopped before publishing anything unsafe, naming the file and pointer', () => {
  const listingText = JSON.stringify({ files: [{ path: 'voice/AKIAABCDEFGHIJKLMNOP.mp3' }] });
  const safeManifest = JSON.stringify(manifestWith('assets/cat.png'));
  const listingPath = '.cratepin-generation.json';
  const error = unsafeOutputError(
    { manifestText: safeManifest, listingText, listingPath },
    CONTEXT,
  );
  assert.deepEqual(
    [error?.code, error?.details.reason, error?.details.path],
    ['INVALID_DATA', 'MANIFEST_UNSAFE_VALUE', '.cratepin-generation.json#/files/0/path'],
  );
  const clean = {
    manifestText: safeManifest,
    listingText: JSON.stringify({ files: [] }),
    listingPath,
  };
  assert.equal(unsafeOutputError(clean, CONTEXT), undefined);
});

test('the storage host comes from the project, and only a whole host name matches it', async () => {
  await withWorkspace(async (workspace) => {
    const read = { transport: 'public-http', publicBaseUrl: 'https://pub-0123.r2.dev/assets' };
    const project = await checkedProjectIn(workspace, { r2: { read } });
    const context = unsafeValueContextOf(project);
    assert.deepEqual(context, { storageAddresses: ['pub-0123.r2.dev'] });
    assert.deepEqual(pointersIn({ url: 'pub-0123.r2.dev/assets/x.png' }, context), ['/url']);
    assert.deepEqual(pointersIn({ url: 'a/pub-0123.r2.dev/b' }, context), ['/url']);
    for (const near of ['xpub-0123.r2.dev/a', 'pub-0123.r2.dev.png', 'assets/app/x.png']) {
      assert.deepEqual(pointersIn({ source: near }, context), [], near);
    }
  });
});

test('a hex-named asset is shown by its name; only a credential-shaped key is hidden', () => {
  const hexId = `sprites/${'a'.repeat(32)}`;
  assert.deepEqual(flaggedPointers({ assets: { [hexId]: { url: '../x.png' } } }), [
    `/assets/sprites~1${'a'.repeat(32)}/url`,
  ]);
});

test('a key carrying URL user info or a signed query is hidden in the pointer', () => {
  const keys = ['https://user:hunter2pass@cdn.example/x', 'x.png?X-Amz-Signature=abc'];
  for (const key of keys) {
    const pointers = flaggedPointers({ assets: { [key]: {} } });
    assert.ok(pointers.length > 0, key);
    assert.ok(
      pointers.every((pointer) => pointer === '/assets/[REDACTED]#key'),
      key,
    );
  }
});
