import assert from 'node:assert/strict';
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import test, { after } from 'node:test';

import { installProcessLivenessProbe } from '../../cache/claim-processes.test-support.ts';
import { PipelineError } from '../../errors.ts';
import { linkDirectory, withWorkspace } from '../../paths/layout/layout-fixtures.test-support.ts';
import {
  failAt,
  vanishedAt,
  withFileStepFaults,
} from '../publication/file-step-faults.test-support.ts';
import { claimOutputForBuild } from './output-claim.ts';

const claimProcess = installProcessLivenessProbe(process.ppid);
after(claimProcess.restore);

async function withOutputRoot(
  useRoot: (root: string, publicDirectory: string) => Promise<void>,
): Promise<void> {
  await withWorkspace(async (workspace) => {
    const publicDirectory = join(workspace, 'public');
    await mkdir(join(publicDirectory, 'assets'), { recursive: true });
    await useRoot(join(publicDirectory, 'assets'), publicDirectory);
  });
}

function isConflict(error: unknown): boolean {
  return error instanceof PipelineError && error.code === 'OUTPUT_CONFLICT';
}

test('a released output claim leaves nothing next to the root', async () => {
  await withOutputRoot(async (root, publicDirectory) => {
    const claim = await claimOutputForBuild(root);
    assert.deepEqual(await readdir(publicDirectory), ['.assets.cratepin', 'assets']);
    await claim.release();
    assert.deepEqual(await readdir(publicDirectory), ['assets']);
  });
});

test('a live output claim keeps a second build out; a dead one is removed', async () => {
  await withOutputRoot(async (root) => {
    const first = await claimOutputForBuild(root);
    await assert.rejects(claimOutputForBuild(root), isConflict);
    await first.release();
    const claims = join(root, '..', '.assets.cratepin', 'claims');
    await mkdir(claims, { recursive: true });
    const dead = {
      pid: claimProcess.pid,
      host: hostname(),
      command: 'build',
      startedAt: new Date().toISOString(),
    };
    await writeFile(
      join(claims, 'build-0b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.json'),
      JSON.stringify(dead),
    );
    const next = await claimOutputForBuild(root);
    assert.deepEqual(await readdir(claims), [basename(next.file)]);
    await next.release();
  });
});

test('a link in place of the work directory is never written through', async () => {
  await withOutputRoot(async (root, publicDirectory) => {
    const elsewhere = join(publicDirectory, '..', 'elsewhere');
    await mkdir(elsewhere);
    await mkdir(join(elsewhere, 'claims'));
    await linkDirectory(elsewhere, join(publicDirectory, '.assets.cratepin'));
    await assert.rejects(claimOutputForBuild(root), isConflict);
    assert.deepEqual(await readdir(elsewhere), ['claims'], 'nothing removed behind the link');
  });
});

function claimOf(root: string): () => ReturnType<typeof claimOutputForBuild> {
  return () => claimOutputForBuild(root);
}

function keyOf({ key }: { readonly key: string }): string {
  return key;
}

test('a claim whose temporary file cannot be removed at once still holds the root; release removes it', async () => {
  await withOutputRoot(async (root, publicDirectory) => {
    const removal = { key: 'rm .assets.cratepin/claims/.<uuid>.tmp', occurrence: 0 };
    const run = await withFileStepFaults(publicDirectory, failAt(removal), claimOf(root));
    assert.deepEqual(run.faults.map(keyOf), [removal.key], 'the removal was failed');
    assert.ok(run.result !== undefined, 'the claim was made');
    await assert.rejects(claimOutputForBuild(root), isConflict, 'and it holds the root');
    await run.result.release();
    assert.deepEqual(await readdir(publicDirectory), ['assets'], 'its temporary file went too');
  });
});

test('a claim temporary file torn by a crash goes once a minute old; a fresh one stays', async () => {
  await withOutputRoot(async (root) => {
    const claims = join(root, '..', '.assets.cratepin', 'claims');
    await mkdir(claims, { recursive: true });
    const torn = '.0b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.tmp';
    const fresh = '.1b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.tmp';
    await writeFile(join(claims, torn), '');
    await writeFile(join(claims, fresh), '');
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    await utimes(join(claims, torn), twoMinutesAgo, twoMinutesAgo);
    const claim = await claimOutputForBuild(root);
    await claim.release();
    assert.deepEqual(await readdir(claims), [fresh]);
  });
});

test('a claim whose directory another config’s release removed meanwhile is made again', async () => {
  await withOutputRoot(async (root, publicDirectory) => {
    const write = { key: 'writeFile .assets.cratepin/claims/.<uuid>.tmp', occurrence: 0 };
    const run = await withFileStepFaults(publicDirectory, vanishedAt(write), claimOf(root));
    assert.deepEqual(run.faults.map(keyOf), [write.key], 'the first write found no directory');
    assert.ok(run.result !== undefined, 'the claim was made on the next attempt');
    await run.result.release();
    assert.deepEqual(await readdir(publicDirectory), ['assets']);
  });
});

test('a claim that fails after making its directories leaves none of them behind', async () => {
  await withOutputRoot(async (root, publicDirectory) => {
    const write = { key: 'writeFile .assets.cratepin/claims/.<uuid>.tmp', occurrence: 0 };
    const run = await withFileStepFaults(publicDirectory, failAt(write), claimOf(root));
    assert.deepEqual(run.faults.map(keyOf), [write.key], 'the claim write was failed');
    assert.equal(run.result, undefined, 'the claim was refused');
    assert.ok(run.error !== undefined);
    assert.deepEqual(await readdir(publicDirectory), ['assets']);
  });
});

test('a dead claim that cannot be removed at once leaves the claim made; a later one removes it', async () => {
  await withOutputRoot(async (root, publicDirectory) => {
    const claims = join(publicDirectory, '.assets.cratepin', 'claims');
    await mkdir(claims, { recursive: true });
    const dead = join(claims, 'build-0b9c2f4e-6a1d-4f4e-9a3b-2c1d0e9f8a7b.json');
    const owner = { pid: claimProcess.pid, host: hostname() };
    await writeFile(dead, JSON.stringify({ ...owner, command: 'build', startedAt: '' }));
    const removal = { key: 'rm .assets.cratepin/claims/build-<uuid>.json', occurrence: 0 };
    const run = await withFileStepFaults(publicDirectory, failAt(removal), claimOf(root));
    assert.deepEqual(run.faults.map(keyOf), [removal.key], 'the removal was failed');
    assert.ok(run.result !== undefined, 'the claim was made all the same');
    await run.result.release();
    assert.deepEqual(await readdir(claims), [basename(dead)], 'the dead claim is still there');
    const next = await claimOutputForBuild(root);
    await next.release();
    assert.deepEqual(await readdir(publicDirectory), ['assets'], 'the next claim removed it');
  });
});
