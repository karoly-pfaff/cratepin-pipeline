import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAndRequireSuccess, runNpmAndRequireSuccess } from './package-process.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const NETWORK_BLOCK = new URL('../tests/support/network-block.test-support.mjs', import.meta.url)
  .href;
const FINGERPRINT_PROGRAM = `import { encoderFingerprint } from '@karoly-pfaff/cratepin';
console.log(JSON.stringify(encoderFingerprint()));`;

async function sha256File(absolutePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyIdenticalRepack(firstPack, secondPack) {
  const firstSha256 = await sha256File(firstPack.tarballPath);
  assert.equal(await sha256File(secondPack.tarballPath), firstSha256, 'Tarball repacking drift');
  assert.equal(secondPack.integrity, firstPack.integrity, 'npm integrity must agree too');
  return firstSha256;
}

function installedEncoderFingerprint(consumerDirectory) {
  const run = runAndRequireSuccess(
    process.execPath,
    ['--import', NETWORK_BLOCK, '--input-type=module', '-e', FINGERPRINT_PROGRAM],
    {
      cwd: consumerDirectory,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    },
  );
  assert.ok(!run.diagnostics.includes('NETWORK_ATTEMPT'), run.diagnostics);
  return JSON.parse(run.stdout);
}

function matchingConsumerFingerprint(consumerDirectories) {
  assert.equal(consumerDirectories.length, 2, 'Two independent external installations required');
  const fingerprints = consumerDirectories.map(installedEncoderFingerprint);
  assert.deepEqual(fingerprints[0], fingerprints[1], 'Installed encoder drift');
  return fingerprints[0];
}

export async function candidateReportOf({ firstPack, secondPack, consumerDirectories }) {
  return {
    schemaVersion: 1,
    packageName: '@karoly-pfaff/cratepin',
    version: firstPack.version,
    filename: firstPack.filename,
    sha256: await verifyIdenticalRepack(firstPack, secondPack),
    bytes: (await stat(firstPack.tarballPath)).size,
    integrity: firstPack.integrity,
    packedPaths: firstPack.packedPaths,
    dependencyLockSha256: await sha256File(join(REPOSITORY_ROOT, 'package-lock.json')),
    node: process.version,
    npm: runNpmAndRequireSuccess(['--version']).stdout.trim(),
    encoder: matchingConsumerFingerprint(consumerDirectories),
    checks: {
      isRepackIdentical: true,
      externalInstallCount: consumerDirectories.length,
      hasPassedPublicCliApiTypesRecipes: true,
    },
    scope: 'Private trial; the measured host is recorded above, broader qualification is separate.',
  };
}

async function prepareOwnedDirectory(absolutePath) {
  await mkdir(absolutePath).catch((directoryError) => {
    if (directoryError.code !== 'EEXIST') throw directoryError;
  });
  const directoryStats = await lstat(absolutePath);
  assert.ok(
    directoryStats.isDirectory() && !directoryStats.isSymbolicLink(),
    'Candidate artifact directories must be real directories, not links',
  );
  assert.equal(await realpath(absolutePath), absolutePath);
  return absolutePath;
}

async function prepareCandidateRoot() {
  const repositoryRoot = await realpath(REPOSITORY_ROOT);
  const stateDirectory = await prepareOwnedDirectory(join(repositoryRoot, '.cratepin-state'));
  return prepareOwnedDirectory(join(stateDirectory, 'candidates'));
}

export async function writeCandidateArtifacts(tarballPath, report) {
  const candidateRoot = await prepareCandidateRoot();
  const candidateDirectory = await mkdtemp(join(candidateRoot, `${report.version}-`));
  await copyFile(tarballPath, join(candidateDirectory, report.filename));
  assert.equal(await sha256File(join(candidateDirectory, report.filename)), report.sha256);
  await writeFile(
    join(candidateDirectory, 'candidate.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  await writeFile(join(candidateDirectory, 'SHA256SUMS'), `${report.sha256}  ${report.filename}\n`);
  return candidateDirectory;
}
