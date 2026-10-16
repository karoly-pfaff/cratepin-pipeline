import assert from 'node:assert/strict';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { originalPathOf } from '../../cache/cache-layout.ts';
import { dryRunReportOf } from '../commands/build-command.ts';
import { buildPreviewReport } from './build-report.ts';
import { encoderFingerprint } from '../../media/encoding/encoder-fingerprint.ts';
import { pngOf, transparentArtwork } from '../../media/testing/media-fixtures.test-support.ts';
import { RUNTIME_MANIFEST_NAME } from '../../output/layout/output-paths.ts';
import { outputMarkerTextOf } from '../../output/ownership/output-marker.ts';
import { writeOwnedTree } from '../../output/publication/publication-fixtures.test-support.ts';
import { workDirectoryOf } from '../../output/layout/work-directory.ts';
import { generationLayoutOf } from '../../output/generation/generation-layout.ts';
import { exitCodeOf } from '../../report.ts';
import type { OperationReport } from '../../report.ts';
import { buildAssetOutputs, imageGateFor } from '../../building/assembly/asset-outputs.ts';
import { failsBecause, withBuildFixture } from '../../building/build-fixtures.test-support.ts';
import { buildOf } from '../../building/build-runs.test-support.ts';
import type { BuildFixture, FixtureOriginal } from '../../building/build-fixtures.test-support.ts';
import { planBuild } from '../../building/planning/build-plan.ts';
import { previewBuild } from '../../building/planning/build-preview.ts';
import { checkOutput } from '../../doctor/project-checks.ts';
import { linkDirectory } from '../../paths/layout/layout-fixtures.test-support.ts';
import { assembleOutput } from '../../building/assembly/output-assembly.ts';

const CONFIG = {
  profiles: { 'ui-strict': { kind: 'image', webp: { lossless: true, keepSmaller: false } } },
};

async function originals(): Promise<FixtureOriginal[]> {
  return [
    {
      source: 'app/ui/button.png',
      bytes: await pngOf(transparentArtwork(9, 9)),
      profile: 'ui-strict',
    },
    {
      source: 'voice/hu/hello.mp3',
      bytes: Buffer.from('ID3 hello'),
      category: 'voice',
      locale: 'hu',
    },
  ];
}

function issueSummaries(report: OperationReport): string[] {
  return report.issues.map(({ code, path }) => `${code} ${path}`);
}

function issueCodes(report: OperationReport): string[] {
  return report.issues.map(({ code }) => code);
}

function previewOf(fixture: BuildFixture) {
  const plan = planBuild(fixture.project.config, fixture.lock);
  assert.deepEqual(plan.issues, [], 'a clean plan');
  return previewBuild({ project: fixture.project, lock: fixture.lock, plan, concurrency: 2 });
}

/** The dry run exactly as the command runs it. */
function dryRunOf(fixture: BuildFixture, isOffline = true): Promise<OperationReport> {
  return dryRunReportOf({ project: fixture.project, lock: fixture.lock, isOffline }, 2);
}

async function convertEverything(fixture: BuildFixture) {
  const plan = planBuild(fixture.project.config, fixture.lock);
  return buildAssetOutputs({
    layout: fixture.layout,
    assets: plan.assets,
    fingerprint: encoderFingerprint(),
    maxImagePixels: fixture.project.config.limits.maxImagePixels,
    concurrency: 2,
    imageGate: imageGateFor(2, 2),
  });
}

function reportOf(
  fixture: BuildFixture,
  preview: Awaited<ReturnType<typeof previewBuild>>,
  isOffline = true,
) {
  return buildPreviewReport({ project: fixture.project, lock: fixture.lock, isOffline }, preview);
}

test('before any conversion, a dry run knows the copies and says what it would convert', async () => {
  await withBuildFixture(await originals(), CONFIG, async (fixture) => {
    const report = reportOf(fixture, await previewOf(fixture));
    assert.equal(report.status, 'succeeded');
    assert.deepEqual(
      [report.facts.copiedCount, report.facts.wouldConvertCount, report.facts.isPlanComplete],
      [1, 1, false],
    );
    assert.deepEqual(report.facts.pendingIds, ['app/ui/button']);
    assert.equal(report.facts.outputRootState, 'absent');
    assert.equal(report.facts.outputUrlPath, 'assets');
    assert.equal(report.facts.generation, undefined);
  });
});

test('with every output known, a dry run gives the generation a build would publish', async () => {
  await withBuildFixture(await originals(), CONFIG, async (fixture) => {
    const { built } = await convertEverything(fixture);
    const preview = await previewOf(fixture);
    const { assembled } = preview;
    assert.ok(assembled !== undefined);
    assert.equal(
      assembled.manifestText,
      assembleOutput(fixture.project.config, built).manifestText,
    );
    const report = reportOf(fixture, preview);
    assert.deepEqual([report.facts.reusedCount, report.facts.isPlanComplete], [1, true]);
    assert.equal(report.facts.generation, assembled.generation);
    assert.deepEqual(report.facts.extensionChanges, [
      {
        id: 'app/ui/button',
        source: 'app/ui/button.png',
        outputPath: 'app/ui/button.webp',
        fromExtension: 'png',
        toExtension: 'webp',
      },
    ]);
    assert.deepEqual(issueSummaries(report), ['EXTENSION_CHANGED app/ui/button.png']);
  });
});

test('a dry run compares with the published manifest of an owned output', async () => {
  await withBuildFixture(await originals(), CONFIG, async (fixture) => {
    await convertEverything(fixture);
    const root = await writeOwnedTree(fixture.project.paths.outputRoot, {});
    const published = {
      assets: {
        'voice/hu/hello': {
          url: 'assets/voice/hu/hello.mp3',
          sha256: fixture.lock.assets[1]?.sha256,
        },
        'app/ui/button': { url: 'assets/app/ui/button.png', sha256: '0'.repeat(64) },
        gone: { url: 'assets/gone.png', sha256: '1'.repeat(64) },
      },
    };
    await writeFile(join(root, RUNTIME_MANIFEST_NAME), JSON.stringify(published));
    const report = reportOf(fixture, await previewOf(fixture));
    assert.equal(exitCodeOf(report), 0, 'the owned root may be built into');
    assert.equal(report.facts.outputRootState, 'owned');
    assert.deepEqual(
      [report.facts.addedIds, report.facts.removedIds, report.facts.changedIds],
      [[], ['gone'], ['app/ui/button']],
    );
  });
});

test('offline, a missing original fails the dry run as a build would, naming it', async () => {
  await withBuildFixture(await originals(), CONFIG, async (fixture) => {
    const missing = fixture.lock.assets[0];
    assert.ok(missing !== undefined);
    await rm(originalPathOf(fixture.layout, missing.sha256));
    const offline = reportOf(fixture, await previewOf(fixture));
    assert.equal(offline.error?.code, 'NOT_FOUND');
    assert.equal(exitCodeOf(offline), 10);
    assert.deepEqual(issueCodes(offline), ['CACHE_MISS', 'EXTENSION_CHANGED']);
    const online = reportOf(fixture, await previewOf(fixture), false);
    assert.equal(online.status, 'succeeded');
    assert.deepEqual([online.facts.wouldDownloadCount, online.facts.cachedCount], [1, 1]);
    assert.deepEqual(
      [offline.facts.missingCount, offline.facts.wouldDownloadCount],
      [1, undefined],
    );
  });
});

test('an output root a build must not touch fails the dry run without touching it', async () => {
  await withBuildFixture(await originals(), CONFIG, async (fixture) => {
    const root = fixture.project.paths.outputRoot;
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'index.html'), 'the host page');
    const report = reportOf(fixture, await previewOf(fixture));
    const { error } = report;
    assert.ok(error !== undefined);
    assert.deepEqual([error.code, error.details.reason], ['OUTPUT_CONFLICT', 'OUTPUT_NOT_OWNED']);
    assert.deepEqual(await readdir(root), ['index.html']);
  });
});

test('an asset its role refuses fails the dry run as invalid data', async () => {
  const printMaster = [
    {
      source: 'print/page.png',
      bytes: await pngOf(transparentArtwork()),
      profile: 'ui-strict',
      role: 'print-master',
    },
  ];
  await withBuildFixture(printMaster, CONFIG, async (fixture) => {
    const report = reportOf(fixture, await previewOf(fixture));
    assert.deepEqual([report.error?.code, report.error?.details.failedCount], ['INVALID_DATA', 1]);
    assert.deepEqual(issueSummaries(report), ['ROLE_NEEDS_COPY print/page.png']);
  });
});

test('a strict WebP extension change is reported before anything is converted', async () => {
  await withBuildFixture(await originals(), CONFIG, async (fixture) => {
    const report = reportOf(fixture, await previewOf(fixture));
    assert.equal(report.facts.wouldConvertCount, 1);
    assert.deepEqual(issueSummaries(report), ['EXTENSION_CHANGED app/ui/button.png']);
    assert.deepEqual(report.facts.assets, [
      { id: 'app/ui/button', profile: 'ui-strict', output: 'wouldConvert' },
      {
        id: 'voice/hu/hello',
        profile: 'copy',
        output: 'copied',
        outputPath: 'voice/hu/hello.mp3',
      },
    ]);
  });
});

test('clashing output paths fail the dry run as invalid data before anything is converted', async () => {
  const clashing: FixtureOriginal[] = [
    { source: 'app/cat.png', bytes: await pngOf(transparentArtwork()), profile: 'ui-strict' },
    { source: 'app/cat.webp', bytes: Buffer.from('webp bytes'), id: 'cat-webp' },
  ];
  await withBuildFixture(clashing, CONFIG, async (fixture) => {
    const report = await dryRunOf(fixture);
    assert.deepEqual(
      [report.error?.code, report.error?.details.problemCount, exitCodeOf(report)],
      ['INVALID_DATA', 1, 8],
    );
    assert.deepEqual(issueSummaries(report), ['OUTPUT_PATH_COLLISION app/cat.webp']);
  });
});

test('the output root is refused first, as a build would meet it first', async () => {
  const printMaster = [
    {
      source: 'print/page.png',
      bytes: await pngOf(transparentArtwork()),
      profile: 'ui-strict',
      role: 'print-master',
    },
  ];
  await withBuildFixture(printMaster, CONFIG, async (fixture) => {
    await mkdir(fixture.project.paths.outputRoot);
    await writeFile(join(fixture.project.paths.outputRoot, 'index.html'), 'host page');
    const report = reportOf(fixture, await previewOf(fixture));
    assert.equal(report.error?.code, 'OUTPUT_CONFLICT');
    assert.equal(exitCodeOf(report), 9);
  });
});

test('a corrupt cache entry gets a notice; offline it counts as missing', async () => {
  await withBuildFixture(await originals(), CONFIG, async (fixture) => {
    const voice = fixture.lock.assets[1];
    assert.ok(voice !== undefined);
    await writeFile(originalPathOf(fixture.layout, voice.sha256), 'damaged');
    const offline = reportOf(fixture, await previewOf(fixture));
    assert.equal(offline.error?.code, 'NOT_FOUND');
    assert.deepEqual(issueSummaries(offline), [
      'EXTENSION_CHANGED app/ui/button.png',
      'CACHE_CORRUPT voice/hu/hello.mp3',
      'CACHE_MISS voice/hu/hello.mp3',
    ]);
  });
});

test('clashing paths are refused before the output root, as a build plans before any I/O', async () => {
  const clashing: FixtureOriginal[] = [
    { source: 'app/cat.png', bytes: await pngOf(transparentArtwork()), profile: 'ui-strict' },
    { source: 'app/cat.webp', bytes: Buffer.from('webp bytes'), id: 'cat-webp' },
  ];
  await withBuildFixture(clashing, CONFIG, async (fixture) => {
    await mkdir(fixture.project.paths.outputRoot);
    await writeFile(join(fixture.project.paths.outputRoot, 'index.html'), 'host page');
    const report = await dryRunOf(fixture);
    assert.equal(report.error?.code, 'INVALID_DATA');
    assert.equal(exitCodeOf(report), 8);
  });
});

test('an undefined profile stops the dry run at the plan, before anything is read', async () => {
  const unknown: FixtureOriginal[] = [
    { source: 'voice/hu/hello.mp3', bytes: Buffer.from('ID3 hello'), category: 'voice' },
    { source: 'app/gone.png', bytes: await pngOf(transparentArtwork()), profile: 'gone' },
  ];
  await withBuildFixture(unknown, CONFIG, async (fixture) => {
    const report = await dryRunOf(fixture);
    assert.deepEqual([report.error?.code, exitCodeOf(report)], ['INVALID_DATA', 8]);
    assert.deepEqual(issueSummaries(report), ['PROFILE_UNKNOWN app/gone.png']);
    assert.deepEqual(
      [report.facts.lockedAssetCount, report.facts.plannedAssetCount, report.facts.outputRootState],
      [2, 1, undefined],
    );
  });
});

test('offline misses are counted per stored object, as pull counts them', async () => {
  const twins: FixtureOriginal[] = [
    { source: 'voice/hu/a.mp3', bytes: Buffer.from('same'), category: 'voice' },
    { source: 'voice/hu/b.mp3', bytes: Buffer.from('same'), category: 'voice' },
  ];
  await withBuildFixture(twins, CONFIG, async (fixture) => {
    const [record] = fixture.lock.assets;
    assert.ok(record !== undefined);
    await rm(originalPathOf(fixture.layout, record.sha256));
    const report = reportOf(fixture, await previewOf(fixture));
    assert.deepEqual([report.error?.details.missingCount, report.facts.missingCount], [1, 1]);
    assert.equal(report.issues.length, 2, 'one CACHE_MISS per locked ID');
  });
});

test('a preview refuses a plan with issues', async () => {
  const clashing: FixtureOriginal[] = [
    { source: 'app/cat.png', bytes: await pngOf(transparentArtwork()), profile: 'ui-strict' },
    { source: 'app/cat.webp', bytes: Buffer.from('webp bytes'), id: 'cat-webp' },
  ];
  await withBuildFixture(clashing, CONFIG, async (fixture) => {
    const plan = planBuild(fixture.project.config, fixture.lock);
    await assert.rejects(
      previewBuild({ project: fixture.project, lock: fixture.lock, plan, concurrency: 1 }),
      /plan without issues/u,
    );
  });
});

test('an owned root a build would refuse for its entries fails the dry run the same way', async () => {
  await withBuildFixture(await originals(), CONFIG, async (fixture) => {
    const root = await writeOwnedTree(fixture.project.paths.outputRoot, { 'old.txt': 'old' });
    await writeFile(join(root, 'notes.txt'), 'mine');
    const report = await dryRunOf(fixture);
    assert.deepEqual(
      [report.error?.details.reason, exitCodeOf(report)],
      ['UNLISTED_OUTPUT_ENTRY', 9],
    );
    assert.ok(issueCodes(report).includes('UNLISTED_OUTPUT_ENTRY'));
  });
});

test('a dry run says when a build would first recover what an earlier build left', async () => {
  await withBuildFixture(await originals(), CONFIG, async (fixture) => {
    await mkdir(workDirectoryOf(fixture.project.paths.outputRoot).directory);
    const report = await dryRunOf(fixture);
    assert.equal(exitCodeOf(report), 0);
    assert.ok(issueCodes(report).includes('BUILD_LEFTOVERS_PENDING'));
  });
});

const GENERATION_CONFIG = { ...CONFIG, outputMode: 'generation' };

test('in generation mode a dry run refuses a link where generations belong and sees leftovers', async () => {
  await withBuildFixture(await originals(), GENERATION_CONFIG, async (fixture) => {
    const layout = generationLayoutOf(fixture.project.paths.outputRoot);
    await mkdir(layout.staging, { recursive: true });
    await writeFile(
      join(layout.root, '.cratepin-output.json'),
      outputMarkerTextOf(fixture.project.config),
    );
    const pending = await dryRunOf(fixture);
    assert.ok(issueCodes(pending).includes('BUILD_LEFTOVERS_PENDING'));
    await writeFile(layout.manifest, '{"name":"another tool"}');
    const foreign = await dryRunOf(fixture);
    assert.deepEqual(
      [foreign.error?.details.reason, exitCodeOf(foreign)],
      ['OUTPUT_MANIFEST_INVALID', 9],
    );
    await rm(layout.generations, { recursive: true });
    await writeFile(layout.generations, 'a file');
    const refused = await dryRunOf(fixture);
    assert.deepEqual(
      [refused.error?.details.reason, exitCodeOf(refused)],
      ['OUTPUT_NOT_A_DIRECTORY', 9],
    );
    await writeFile(
      join(layout.root, '.cratepin-output.json'),
      outputMarkerTextOf({ projectId: 'other', outputMode: 'generation' }),
    );
    await rm(layout.generations);
    await mkdir(layout.staging, { recursive: true });
    const foreignRoot = await dryRunOf(fixture);
    assert.ok(!issueCodes(foreignRoot).includes('BUILD_LEFTOVERS_PENDING'), 'nothing recovered');
  });
});

test('in generation mode a path-preserving build’s work refuses the dry run and doctor, with no recovery promised', async () => {
  await withBuildFixture(await originals(), GENERATION_CONFIG, async (fixture) => {
    await mkdir(workDirectoryOf(fixture.project.paths.outputRoot).staging, { recursive: true });
    const report = await dryRunOf(fixture);
    assert.deepEqual(
      [report.error?.details.reason, exitCodeOf(report)],
      ['PATH_PRESERVING_WORK_LEFT', 9],
    );
    assert.ok(!issueCodes(report).includes('BUILD_LEFTOVERS_PENDING'), 'nothing is recovered');
    const doctor = await checkOutput(fixture.project);
    assert.deepEqual(
      [doctor.status, doctor.error?.details.reason],
      ['failed', 'PATH_PRESERVING_WORK_LEFT'],
    );
  });
});

const MODE_CONFIGS = [
  { mode: 'path-preserving', config: CONFIG },
  { mode: 'generation', config: GENERATION_CONFIG },
];

/** A link, or a plain file, where the work directory or its claims belong. */
const WORK_DIRECTORY_BLOCKERS = [
  {
    name: 'a link at the work directory',
    arrange: async (fixture: BuildFixture) => {
      const elsewhere = join(fixture.workspace, 'elsewhere');
      await mkdir(join(elsewhere, 'staging'), { recursive: true });
      await linkDirectory(elsewhere, workDirectoryOf(fixture.project.paths.outputRoot).directory);
    },
  },
  {
    name: 'a file at the work directory',
    arrange: async (fixture: BuildFixture) => {
      await writeFile(workDirectoryOf(fixture.project.paths.outputRoot).directory, 'a file');
    },
  },
  {
    name: 'a file at the claims',
    arrange: async (fixture: BuildFixture) => {
      const work = workDirectoryOf(fixture.project.paths.outputRoot);
      await mkdir(work.directory, { recursive: true });
      await writeFile(work.claims, 'a file');
    },
  },
];

for (const { mode, config } of MODE_CONFIGS) {
  for (const blocker of WORK_DIRECTORY_BLOCKERS) {
    test(`in ${mode} mode ${blocker.name} refuses the dry run and doctor as the build does`, async () => {
      await withBuildFixture(await originals(), config, async (fixture) => {
        await blocker.arrange(fixture);
        const report = await dryRunOf(fixture);
        assert.deepEqual(
          [report.error?.details.reason, exitCodeOf(report)],
          ['WORK_DIRECTORY_NOT_A_DIRECTORY', 9],
        );
        assert.ok(!issueCodes(report).includes('BUILD_LEFTOVERS_PENDING'), 'nothing is recovered');
        const doctor = await checkOutput(fixture.project);
        assert.deepEqual(
          [doctor.status, doctor.error?.details.reason],
          ['failed', 'WORK_DIRECTORY_NOT_A_DIRECTORY'],
        );
        await assert.rejects(
          buildOf(fixture),
          failsBecause('OUTPUT_CONFLICT', 'WORK_DIRECTORY_NOT_A_DIRECTORY'),
        );
      });
    });
  }

  test(`in ${mode} mode a foreign root next to a dead build's claims promises no recovery`, async () => {
    await withBuildFixture(await originals(), config, async (fixture) => {
      const root = fixture.project.paths.outputRoot;
      await mkdir(root, { recursive: true });
      const other = { projectId: 'other', outputMode: mode as 'path-preserving' | 'generation' };
      await writeFile(join(root, '.cratepin-output.json'), outputMarkerTextOf(other));
      await mkdir(workDirectoryOf(root).claims, { recursive: true });
      const report = await dryRunOf(fixture);
      assert.deepEqual(
        [report.error?.details.reason, exitCodeOf(report)],
        ['OUTPUT_FOREIGN_PROJECT', 9],
      );
      assert.ok(!issueCodes(report).includes('BUILD_LEFTOVERS_PENDING'), 'nothing is recovered');
    });
  });
}

test('a dry run refuses what the scan before publishing would refuse', async () => {
  const credentialNamed: FixtureOriginal = {
    source: 'voice/hu/AKIAABCDEFGHIJKLMNOP.mp3',
    bytes: Buffer.from('ID3 key-shaped name'),
    category: 'voice',
    locale: 'hu',
  };
  await withBuildFixture([credentialNamed], CONFIG, async (fixture) => {
    const report = await dryRunOf(fixture);
    assert.deepEqual(
      [report.error?.details.reason, exitCodeOf(report)],
      ['MANIFEST_UNSAFE_VALUE', 8],
    );
    assert.ok(issueCodes(report).includes('MANIFEST_UNSAFE_VALUE'));
  });
});

function issuePathsOf(report: OperationReport): string[] {
  return report.issues.map(({ path }) => path);
}

function isGenerationListingPath(path: string): boolean {
  return /^generations\/[0-9a-f]{16}\/\.cratepin-generation\.json#/u.test(path);
}

test('in generation mode the dry run names the listing inside its generation', async () => {
  const credentialNamed: FixtureOriginal = {
    source: 'voice/hu/AKIAABCDEFGHIJKLMNOP.mp3',
    bytes: Buffer.from('ID3 key-shaped name'),
    category: 'voice',
  };
  await withBuildFixture([credentialNamed], GENERATION_CONFIG, async (fixture) => {
    const report = await dryRunOf(fixture);
    assert.match(
      String(report.error?.details.path),
      /^cratepin-manifest\.json#|^generations\/[0-9a-f]{16}\/\.cratepin-generation\.json#/u,
    );
    const listingIssuePaths = issuePathsOf(report).filter(isGenerationListingPath);
    assert.ok(listingIssuePaths.length > 0);
  });
});
