import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { candidateReportOf } from '../../scripts/candidate-report.mjs';

test('a changed repack cannot claim reproducibility even with matching npm metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cratepin-repack-'));
  try {
    const firstPack = {
      tarballPath: join(directory, 'firstPack.tgz'),
      integrity: 'same-untrusted-metadata',
    };
    const secondPack = { ...firstPack, tarballPath: join(directory, 'secondPack.tgz') };
    await writeFile(firstPack.tarballPath, 'the reviewed package bytes');
    await writeFile(secondPack.tarballPath, 'different bytes, same claimed integrity');
    await assert.rejects(
      candidateReportOf({ firstPack, secondPack, consumerDirectories: [] }),
      /Tarball repacking drift/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function copyCandidateWriterInto(directory) {
  await mkdir(join(directory, 'scripts'));
  for (const filename of ['candidate-report.mjs', 'package-process.mjs']) {
    await copyFile(
      new URL(`../../scripts/${filename}`, import.meta.url),
      join(directory, 'scripts', filename),
    );
  }
  return import(pathToFileURL(join(directory, 'scripts/candidate-report.mjs')).href);
}

for (const linkedDirectory of ['.cratepin-state', '.cratepin-state/candidates']) {
  test(`candidate artifacts refuse a junction at ${linkedDirectory} before writing through it`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'cratepin-artifact-link-'));
    try {
      const repository = join(workspace, 'repository');
      const outside = join(workspace, 'outside');
      await mkdir(repository);
      await mkdir(outside);
      const writer = await copyCandidateWriterInto(repository);
      const linkPath = join(repository, linkedDirectory);
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(outside, linkPath, 'junction');
      const tarballPath = join(workspace, 'fixture.tgz');
      const tarballBytes = 'reviewed tarball bytes';
      await writeFile(tarballPath, tarballBytes);
      const report = {
        version: '0.1.0-trial.3',
        filename: 'candidate.tgz',
        sha256: createHash('sha256').update(tarballBytes).digest('hex'),
      };
      await assert.rejects(
        writer.writeCandidateArtifacts(tarballPath, report),
        /real directories, not links/u,
      );
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
