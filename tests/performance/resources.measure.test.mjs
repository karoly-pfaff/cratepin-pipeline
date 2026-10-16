import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import { FakeS3 } from '../../sources/storage/testing/fake-s3.test-support.ts';

import {
  DEFAULT_CONFIG_FILE,
  readerVariablesFor,
  startCli,
  withTempDirectory,
  writerVariablesFor,
  writeSourceTree,
} from '../support/cli-runs.test-support.mjs';

// Opt-in resource measurement: set CRATEPIN_MEASURE=1. It prints peak memory (RSS) and
// wall time of real CLI runs against the in-process storage fake, so only the CLI's own memory
// is measured: copied originals of 64 and 512 MiB through scan, push, pull and build; noise PNGs
// of 4096² and 8192² pixels converted to lossless WebP with limits.imageConcurrency 1 and 2; and
// a pull of 500 small originals at --concurrency 64. Nothing is asserted beyond success; the
// numbers are evidence for the documented resource figures. Skipped by default.
const IS_ENABLED = process.env.CRATEPIN_MEASURE === '1';
const MEBIBYTE = 1024 * 1024;
const PEAK_RSS_URL = new URL('./peak-rss.test-support.mjs', import.meta.url).href;

async function measured(directory, variables, ...args) {
  const started = performance.now();
  const start = { directory, variables, nodeOptions: ['--import', PEAK_RSS_URL] };
  const run = await startCli(start, ...args).finished;
  assert.equal(run.status, 0, `${args.join(' ')}: ${run.stderr}`);
  const peakKib = Number(/PEAK_RSS_KIB (\d+)/u.exec(run.stderr)?.[1]);
  return { peakMib: Math.round(peakKib / 1024), seconds: (performance.now() - started) / 1000 };
}

function report(label, { peakMib, seconds }) {
  process.stdout.write(
    `${label.padEnd(44)} peak ${String(peakMib).padStart(5)} MiB  ${seconds.toFixed(1)} s\n`,
  );
}

async function withProjectDirectory(config, useDirectory) {
  const fake = await FakeS3.start();
  try {
    await withTempDirectory(async (directory) => {
      await mkdir(join(directory, 'public'));
      const full = { schemaVersion: 1, projectId: 'demo', ...config };
      await writeFile(join(directory, DEFAULT_CONFIG_FILE), JSON.stringify(full));
      await useDirectory(directory, fake);
    });
  } finally {
    await fake.close();
  }
}

/** Pushes, pulls into a cold cache and builds offline, measuring each command. */
async function measureFlow(label, directory, fake) {
  report(`${label}: scan`, await measured(directory, {}, 'scan'));
  report(`${label}: push`, await measured(directory, writerVariablesFor(fake), 'push'));
  report(`${label}: pull (cold)`, await measured(directory, readerVariablesFor(fake), 'pull'));
  report(`${label}: build --offline`, await measured(directory, {}, 'build', '--offline'));
}

const PARTED = { multipartThresholdBytes: 16 * MEBIBYTE, multipartPartBytes: 16 * MEBIBYTE };

function noisePng(edge, seed) {
  const pixels = Buffer.alloc(edge * edge * 3);
  let state = seed;
  for (let index = 0; index < pixels.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[index] = state & 0xff;
  }
  return sharp(pixels, { raw: { width: edge, height: edge, channels: 3 } })
    .png({ compressionLevel: 1 })
    .toBuffer();
}

async function measureCopies() {
  for (const mib of [64, 512]) {
    await withProjectDirectory({ limits: PARTED }, async (directory, fake) => {
      await writeSourceTree(directory, { 'music/long.mp3': Buffer.alloc(mib * MEBIBYTE, 5) });
      await measureFlow(`copy of ${String(mib)} MiB`, directory, fake);
    });
  }
}

function losslessConfig(imageConcurrency) {
  return {
    limits: { imageConcurrency },
    profiles: { lossless: { kind: 'image', webp: { lossless: true, keepSmaller: false } } },
    defaultProfile: 'lossless',
  };
}

async function measureConversion(edge, imageConcurrency, originals) {
  await withProjectDirectory(losslessConfig(imageConcurrency), async (directory, fake) => {
    await writeSourceTree(directory, originals);
    await measured(directory, writerVariablesFor(fake), 'push');
    await measured(directory, readerVariablesFor(fake), 'pull');
    const label = `two ${String(edge)}² noise PNGs, imageConcurrency ${String(imageConcurrency)}`;
    report(label, await measured(directory, {}, 'build', '--offline'));
  });
}

async function measureConversions() {
  for (const edge of [4096, 8192]) {
    const originals = {
      'images/a.png': await noisePng(edge, 0x9e3779b9),
      'images/b.png': await noisePng(edge, 0x85ebca6b),
    };
    for (const imageConcurrency of [1, 2])
      await measureConversion(edge, imageConcurrency, originals);
  }
}

function smallOriginals(count) {
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    entries.push([`voice/line-${String(index)}.mp3`, `ID3 ${String(index)}`]);
  }
  return Object.fromEntries(entries);
}

async function measureStorm() {
  await withProjectDirectory({}, async (directory, fake) => {
    await writeSourceTree(directory, smallOriginals(500));
    await measured(directory, writerVariablesFor(fake), 'push');
    fake.simulate({ responseDelayMs: 20 });
    const storm = await measured(
      directory,
      readerVariablesFor(fake),
      'pull',
      '--concurrency',
      '64',
    );
    report('pull of 500 originals, --concurrency 64', storm);
    process.stdout.write(`  most GETs at once: ${String(fake.maxConcurrentByMethod.get('GET'))}
`);
  });
}

test('resource measurement', { skip: !IS_ENABLED }, async () => {
  process.stdout.write(
    `
${platform()} ${arch()}, ${String(cpus().length)} CPUs, ${String(Math.round(totalmem() / 1024 ** 3))} GiB, Node ${process.versions.node}, Sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}
`,
  );
  await measureCopies();
  await measureConversions();
  await measureStorm();
});
