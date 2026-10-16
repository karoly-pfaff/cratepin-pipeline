import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assetUrlOf,
  assetUrlsOf,
  loadAssetUrls,
  siteBaseUrl,
} from '../../examples/vite-consumer/src/assetUrls.js';
import {
  gradientBackgroundPng,
  pngOf,
  transparentArtwork,
} from '../../sources/media/testing/media-fixtures.test-support.ts';
import { FakeS3 } from '../../sources/storage/testing/fake-s3.test-support.ts';

import { snapshotOf } from '../building/projects.test-support.mjs';
import {
  DEFAULT_CONFIG_FILE,
  readerVariablesFor,
  runCliAsync,
  withTempDirectory,
  writerVariablesFor,
  writeSourceTree,
} from '../support/cli-runs.test-support.mjs';

const EXAMPLE = fileURLToPath(new URL('../../examples/vite-consumer/', import.meta.url));
const BACKGROUND_ID = 'scenes/forest/backgrounds/meadow';
const BACKGROUND_PATH = 'assets/scenes/forest/backgrounds/meadow.webp';
/** Where the static host below serves the published `public/` directory. */
const SUBPATH = '/games/forest/';

function backgroundUrlFor(hostBase, pageUrl) {
  const manifest = { assets: { [BACKGROUND_ID]: { url: BACKGROUND_PATH } } };
  return assetUrlOf(assetUrlsOf(manifest, siteBaseUrl(hostBase, pageUrl)), BACKGROUND_ID).href;
}

test('a relative base resolves assets at a domain root, a subpath and Capacitor origins', () => {
  const pages = [
    ['https://games.example/', 'https://games.example/'],
    ['https://games.example/index.html', 'https://games.example/'],
    ['https://games.example/forest/', 'https://games.example/forest/'],
    ['https://games.example/forest/index.html', 'https://games.example/forest/'],
    ['https://localhost/', 'https://localhost/'],
    ['capacitor://localhost/index.html', 'capacitor://localhost/'],
  ];
  for (const [pageUrl, siteBase] of pages)
    assert.equal(backgroundUrlFor('./', pageUrl), `${siteBase}${BACKGROUND_PATH}`, pageUrl);
});

test('an absolute subpath base serves deep routes; a relative base needs the trailing slash', () => {
  assert.equal(
    backgroundUrlFor('/forest/', 'https://games.example/forest/level/2'),
    `https://games.example/forest/${BACKGROUND_PATH}`,
  );
  assert.equal(
    backgroundUrlFor('./', 'https://games.example/forest'),
    `https://games.example/${BACKGROUND_PATH}`,
    'as the example README says, ./ of a page without the slash is its parent directory',
  );
});

test('encoded file names stay encoded and an unknown ID is an error, not a guessed path', () => {
  const manifest = { assets: { 'ui/a b': { url: 'assets/ui/a%20b.png' } } };
  const assetUrls = assetUrlsOf(manifest, siteBaseUrl('./', 'https://games.example/forest/'));
  assert.equal(
    assetUrlOf(assetUrls, 'ui/a b').href,
    'https://games.example/forest/assets/ui/a%20b.png',
  );
  assert.throws(() => assetUrlOf(assetUrls, 'ui/missing'), /no asset "ui\/missing"/);
});

test('the example builds and verifies assets before the web build and never uploads', async () => {
  const { scripts } = JSON.parse(await readFile(join(EXAMPLE, 'package.json'), 'utf8'));
  assert.equal(scripts.prebuild, 'npm run assets:build');
  assert.equal(scripts['assets:build'], 'cratepin build && cratepin verify');
  assert.equal(scripts.build, 'vite build');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack'])
    assert.equal(scripts[hook], undefined, hook);
  const uploading = Object.keys(scripts).filter((name) => scripts[name].includes('push'));
  assert.deepEqual(uploading, ['assets:push'], 'only the explicit author script uploads');
  const viteConfig = await readFile(join(EXAMPLE, 'vite.config.js'), 'utf8');
  assert.match(viteConfig, /base: '\.\/'/);
  assert.match(viteConfig, /assetsDir: 'bundle'/, 'Vite bundles stay out of the assets tree');
});

/** The example's config and game data, with its three originals as the author has them. */
async function writeExampleProject(directory) {
  await cp(join(EXAMPLE, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(EXAMPLE, 'public'), join(directory, 'public'), { recursive: true });
  await cp(join(EXAMPLE, DEFAULT_CONFIG_FILE), join(directory, DEFAULT_CONFIG_FILE));
  await writeSourceTree(directory, {
    'scenes/forest/backgrounds/meadow.png': await gradientBackgroundPng(),
    'scenes/forest/characters/fox.png': await pngOf(transparentArtwork(9, 9)),
    'scenes/forest/voice/hu/find-the-fox.mp3': 'ID3 find the fox',
  });
}

/** Everything a build must leave alone: game data, originals, config and lock. */
async function authoredFilesOf(directory) {
  return {
    gameData: await snapshotOf(join(directory, 'src')),
    originals: await snapshotOf(join(directory, 'assets', 'source')),
    config: await readFile(join(directory, DEFAULT_CONFIG_FILE), 'utf8'),
    lock: await readFile(join(directory, 'cratepin-lock.json'), 'utf8'),
  };
}

async function sendPublishedFile(publicDirectory, request, response) {
  const [pathname = ''] = (request.url ?? '').split('?');
  const file = resolve(publicDirectory, decodeURIComponent(pathname.slice(SUBPATH.length)));
  const isServed = pathname.startsWith(SUBPATH) && file.startsWith(`${publicDirectory}${sep}`);
  const bytes = isServed ? await readFile(file).catch(() => undefined) : undefined;
  if (bytes === undefined) response.writeHead(404).end();
  else response.writeHead(200).end(bytes);
}

/** A static host serving `publicDirectory` under SUBPATH, as a web server serves `dist/`. */
async function withSubpathHost(publicDirectory, useHost) {
  const server = createServer((request, response) => {
    void sendPublishedFile(publicDirectory, request, response);
  });
  await new Promise((started) => server.listen(0, '127.0.0.1', started));
  try {
    await useHost(`http://127.0.0.1:${String(server.address().port)}${SUBPATH}`);
  } finally {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  }
}

async function sha256Of(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, url.href);
  return createHash('sha256')
    .update(Buffer.from(await response.arrayBuffer()))
    .digest('hex');
}

/** Each scene ID, fetched through the example's lookup from the hosted page, has its bytes. */
async function assertSceneServed(directory, pageUrl) {
  const scene = JSON.parse(await readFile(join(directory, 'src', 'scenes', 'forest.json'), 'utf8'));
  const manifestPath = join(directory, 'public', 'assets', 'cratepin-manifest.json');
  const { assets } = JSON.parse(await readFile(manifestPath, 'utf8'));
  const assetUrls = await loadAssetUrls(siteBaseUrl('./', pageUrl));
  for (const id of Object.values(scene))
    assert.equal(await sha256Of(assetUrlOf(assetUrls, id)), assets[id].sha256, id);
  const legacyPng = new URL('assets/scenes/forest/backgrounds/meadow.png', pageUrl);
  assert.equal((await fetch(legacyPng)).status, 404, 'the background is WebP now: look it up');
}

function isStorageWrite({ method }) {
  return method !== 'GET' && method !== 'HEAD';
}

/** The author pushes, the build gets the originals with read access only, verify passes. */
async function publishAndServeExample(directory, fake) {
  await writeExampleProject(directory);
  const push = await runCliAsync(directory, writerVariablesFor(fake), 'push', '--json');
  assert.equal(push.status, 0, push.stderr);
  const before = await authoredFilesOf(directory);
  const requestsBeforeBuild = fake.requests.length;
  const build = await runCliAsync(directory, readerVariablesFor(fake), 'build', '--json');
  assert.equal(build.status, 0, build.stderr);
  const verify = await runCliAsync(directory, {}, 'verify', '--json');
  assert.equal(verify.status, 0, verify.stderr);
  assert.deepEqual(await authoredFilesOf(directory), before);
  const buildRequests = fake.requests.slice(requestsBeforeBuild);
  assert.deepEqual(buildRequests.filter(isStorageWrite), [], 'build and verify only read storage');
  assert.ok(
    buildRequests.some(({ method }) => method === 'GET'),
    'the build downloaded originals',
  );
  await withSubpathHost(join(directory, 'public'), (pageUrl) =>
    assertSceneServed(directory, pageUrl),
  );
}

test('the example consumer pushes, builds, verifies and serves its scene under a subpath', async () => {
  const fake = await FakeS3.start();
  try {
    await withTempDirectory((directory) => publishAndServeExample(directory, fake));
  } finally {
    await fake.close();
  }
});
