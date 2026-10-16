import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  candidateReportOf,
  verifyIdenticalRepack,
  writeCandidateArtifacts,
} from './candidate-report.mjs';
import { checkExternalPackageConsumer } from './package-consumer.mjs';
import { packCheckedTarball } from './package-tarball.mjs';

async function packTwice(workDirectory) {
  const packages = [];
  for (const packName of ['pack-1', 'pack-2']) {
    const packDirectory = join(workDirectory, packName);
    await mkdir(packDirectory);
    packages.push(packCheckedTarball(packDirectory));
  }
  return packages;
}

async function checkTwice(workDirectory, tarballPath) {
  const consumerDirectories = [];
  for (const consumerName of ['consumer-1', 'consumer-2']) {
    const consumerDirectory = join(workDirectory, consumerName);
    await mkdir(consumerDirectory);
    await checkExternalPackageConsumer(consumerDirectory, tarballPath);
    consumerDirectories.push(consumerDirectory);
  }
  return consumerDirectories;
}

const workDirectory = await mkdtemp(join(tmpdir(), 'cratepin-candidate-'));
try {
  const [firstPack, secondPack] = await packTwice(workDirectory);
  const initialSha256 = await verifyIdenticalRepack(firstPack, secondPack);
  const consumerDirectories = await checkTwice(workDirectory, firstPack.tarballPath);
  const report = await candidateReportOf({ firstPack, secondPack, consumerDirectories });
  assert.equal(report.sha256, initialSha256, 'Tarball changed during consumer verification');
  const candidateDirectory = await writeCandidateArtifacts(firstPack.tarballPath, report);
  console.log(
    `Private tarball repack/install checks passed: ${candidateDirectory}\nSHA256 ${report.sha256}`,
  );
} finally {
  await rm(workDirectory, { recursive: true, force: true });
}
