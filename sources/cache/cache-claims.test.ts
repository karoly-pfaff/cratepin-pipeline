import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import test, { after } from 'node:test';

import { compareCodeUnits } from '../catalog/ordering.ts';
import { failsWith, withPreparedCache } from './cache-fixtures.test-support.ts';
import {
  claimCacheExclusively,
  claimCacheForBuild,
  claimCacheUse,
  isClaimLive,
} from './cache-claims.ts';
import type { CacheLayout } from './cache-layout.ts';
import { installProcessLivenessProbe } from './claim-processes.test-support.ts';

const claimProcess = installProcessLivenessProbe(process.ppid);
after(claimProcess.restore);

/** Another live Node process; the caller ends it. */
function startLiveProcess(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
}

function nameOf(file: string): string {
  return basename(file);
}

function sortedNames(names: readonly string[]): string[] {
  return names.toSorted(compareCodeUnits);
}

/** Writes the claim another run would write; returns its file name. */
async function writeOtherClaim(
  layout: CacheLayout,
  kind: 'use' | 'build' | 'prune',
  owner: object | string,
): Promise<string> {
  const name = `${kind}-${randomUUID()}.json`;
  const text = typeof owner === 'string' ? owner : JSON.stringify(owner);
  await writeFile(join(layout.claims, name), text);
  return name;
}

function ownerWith(pid: number, host = hostname()): object {
  return { pid, host, command: 'pull', startedAt: '2026-10-11T00:00:00.000Z' };
}

test('liveness keeps self and other hosts live, while an explicit ESRCH is dead', () => {
  assert.equal(isClaimLive(undefined), true, 'unreadable claims count as live');
  assert.equal(isClaimLive({ pid: process.pid, host: hostname(), command: 'pull' }), true);
  assert.equal(isClaimLive({ pid: claimProcess.pid, host: hostname(), command: 'pull' }), false);
  const elsewhere = { pid: claimProcess.pid, host: `${hostname()}-other`, command: 'pull' };
  assert.equal(isClaimLive(elsewhere), true, 'another host cannot be checked');
});

test('use claims coexist and are removed on release', async () => {
  await withPreparedCache(async (layout) => {
    const first = await claimCacheUse(layout, 'pull');
    const second = await claimCacheUse(layout, 'pull');
    assert.equal((await readdir(layout.claims)).length, 2);
    await first.release();
    await second.release();
    await second.release();
    assert.deepEqual(await readdir(layout.claims), []);
  });
});

test('a live prune keeps pulls out; a dead one is ignored', async () => {
  const live = startLiveProcess();
  try {
    await withPreparedCache(async (layout) => {
      const pruning = await writeOtherClaim(layout, 'prune', ownerWith(live.pid ?? 0));
      await assert.rejects(claimCacheUse(layout, 'pull'), failsWith('OUTPUT_CONFLICT'));
      assert.deepEqual(await readdir(layout.claims), [pruning], 'the refused claim is withdrawn');
      const dead = await writeOtherClaim(layout, 'prune', ownerWith(claimProcess.pid));
      await rm(join(layout.claims, pruning));
      const pull = await claimCacheUse(layout, 'pull');
      await pull.release();
      assert.deepEqual(await readdir(layout.claims), [dead], 'a pull never removes claims');
    });
  } finally {
    live.kill();
  }
});

test('a build runs alongside pulls but not alongside another build or a live prune', async () => {
  await withPreparedCache(async (layout) => {
    const pull = await claimCacheUse(layout, 'pull');
    const build = await claimCacheForBuild(layout, 'build');
    await assert.rejects(claimCacheForBuild(layout, 'build'), failsWith('OUTPUT_CONFLICT'));
    assert.equal((await readdir(layout.claims)).length, 2, 'the refused claim is withdrawn');
    await build.release();
    await pull.release();
    const dead = await writeOtherClaim(layout, 'build', ownerWith(claimProcess.pid));
    const after = await claimCacheForBuild(layout, 'build');
    await after.release();
    assert.deepEqual(await readdir(layout.claims), [dead], 'a dead build is ignored, not removed');
  });
});

test('a pruning run keeps a build out', async () => {
  const live = startLiveProcess();
  try {
    await withPreparedCache(async (layout) => {
      await writeOtherClaim(layout, 'prune', ownerWith(live.pid ?? 0));
      await assert.rejects(claimCacheForBuild(layout, 'build'), failsWith('OUTPUT_CONFLICT'));
    });
  } finally {
    live.kill();
  }
});

/** Takes no exclusive claim while `owner` (another run's claim content) is in the claims. */
async function assertExclusiveClaimRefused(owner: object | string): Promise<void> {
  await withPreparedCache(async (layout) => {
    await writeOtherClaim(layout, 'use', owner);
    await assert.rejects(
      claimCacheExclusively(layout, 'cache prune'),
      failsWith('OUTPUT_CONFLICT'),
    );
  });
}

test('an exclusive claim waits for no one: any live claim refuses it', async () => {
  const live = startLiveProcess();
  const owners = [ownerWith(live.pid ?? 0), ownerWith(claimProcess.pid, 'build-server'), 'half {'];
  try {
    for (const owner of owners) await assertExclusiveClaimRefused(owner);
  } finally {
    live.kill();
  }
});

test('claims of dead runs are removed by an exclusive claim, unknown files are left', async () => {
  await withPreparedCache(async (layout) => {
    const deadUse = await writeOtherClaim(layout, 'use', ownerWith(claimProcess.pid));
    const deadPrune = await writeOtherClaim(layout, 'prune', ownerWith(claimProcess.pid));
    await writeFile(join(layout.claims, 'notes.txt'), 'not a claim');
    const { claim, removedDeadClaimFiles } = await claimCacheExclusively(layout, 'cache prune');
    assert.deepEqual(
      sortedNames(removedDeadClaimFiles.map(nameOf)),
      sortedNames([deadUse, deadPrune]),
    );
    await claim.release();
    assert.deepEqual(await readdir(layout.claims), ['notes.txt']);
  });
});

test('a pull and a prune in this process exclude each other in either order', async () => {
  await withPreparedCache(async (layout) => {
    const pull = await claimCacheUse(layout, 'pull');
    await assert.rejects(
      claimCacheExclusively(layout, 'cache prune'),
      failsWith('OUTPUT_CONFLICT'),
    );
    await pull.release();
    const { claim } = await claimCacheExclusively(layout, 'cache prune');
    await assert.rejects(claimCacheUse(layout, 'pull'), failsWith('OUTPUT_CONFLICT'));
    await claim.release();
    assert.deepEqual(await readdir(layout.claims), []);
  });
});

test('a run that started long ago is still live; a claim that vanished is not in the way', async () => {
  const live = startLiveProcess();
  try {
    const ancient = {
      pid: live.pid ?? 0,
      host: hostname(),
      command: 'pull',
      startedAt: '2000-01-01T00:00:00.000Z',
    };
    assert.equal(isClaimLive(ancient), true);
    await withPreparedCache(async (layout) => {
      const name = await writeOtherClaim(layout, 'use', ancient);
      await assert.rejects(
        claimCacheExclusively(layout, 'cache prune'),
        failsWith('OUTPUT_CONFLICT'),
      );
      await rm(join(layout.claims, name));
      const { claim } = await claimCacheExclusively(layout, 'cache prune');
      await claim.release();
    });
  } finally {
    live.kill();
  }
});

test('a claim larger than 4 KiB is not read and counts as live, never as dead', async () => {
  await withPreparedCache(async (layout) => {
    const owner = JSON.stringify(ownerWith(claimProcess.pid));
    await writeOtherClaim(layout, 'prune', `${owner}${' '.repeat(4096)}`);
    await assert.rejects(claimCacheUse(layout, 'pull'), failsWith('OUTPUT_CONFLICT'));
  });
});

test('a reused PID remains live until the same probe reports ESRCH', async () => {
  const probesBefore = claimProcess.probeCount();
  claimProcess.setLive(true);
  try {
    await assertExclusiveClaimRefused(ownerWith(claimProcess.pid));
  } finally {
    claimProcess.setLive(false);
  }
  assert.equal(isClaimLive({ pid: claimProcess.pid, host: hostname(), command: 'pull' }), false);
  assert.ok(claimProcess.probeCount() >= probesBefore + 2);
});
