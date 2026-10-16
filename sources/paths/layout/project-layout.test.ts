import assert from 'node:assert/strict';
import { link, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig } from '../../config/pipeline-config.ts';
import type { ConfigIssue, PipelineConfig } from '../../config/pipeline-config.ts';
import { resolveProjectPaths } from '../../config/project-config.ts';
import { linkDirectory, withWorkspace } from './layout-fixtures.test-support.ts';
import { projectLayoutIssues } from './project-layout.ts';

type RootOverrides = Partial<
  Pick<PipelineConfig, 'sourceDir' | 'cacheDir' | 'outputDir' | 'lockFile'>
>;

/** Layout issues of a project whose config file sits directly in `projectDirectory`. */
async function layoutIssuesFor(
  projectDirectory: string,
  overrides: RootOverrides,
): Promise<ConfigIssue[]> {
  const config: PipelineConfig = { ...defaultConfig(), ...overrides };
  const configFile = join(projectDirectory, 'cratepin.config.json');
  await writeFile(configFile, JSON.stringify(config));
  return projectLayoutIssues(resolveProjectPaths(config, configFile));
}

function issueSummaries(issues: readonly ConfigIssue[]): string[] {
  return issues.map((issue) => `${issue.path}: ${issue.message}`);
}

async function withProject(
  useProject: (project: string, workspace: string) => Promise<void>,
): Promise<void> {
  await withWorkspace(async (workspace) => {
    const project = join(workspace, 'project');
    await mkdir(project);
    await useProject(project, workspace);
  });
}

test('the default layout of a fresh project has no issues', async () => {
  await withProject(async (project) => {
    assert.deepEqual(await layoutIssuesFor(project, {}), []);
  });
});

test('nested or equal roots are rejected, also when they differ only by letter case', async () => {
  await withProject(async (project) => {
    const outputInsideSource = await layoutIssuesFor(project, {
      sourceDir: 'assets',
      outputDir: 'assets/out',
    });
    assert.deepEqual(issueSummaries(outputInsideSource), [
      '/outputDir: Overlaps /sourceDir; each root needs its own directory',
    ]);
    const caseOnly = await layoutIssuesFor(project, {
      sourceDir: 'Media',
      cacheDir: 'media/cache',
    });
    assert.deepEqual(issueSummaries(caseOnly), [
      '/cacheDir: Overlaps /sourceDir; each root needs its own directory',
    ]);
    const sourceInsideOutput = await layoutIssuesFor(project, { sourceDir: 'public/assets/src' });
    assert.deepEqual(issueSummaries(sourceInsideOutput), [
      '/outputDir: Overlaps /sourceDir; each root needs its own directory',
    ]);
  });
});

test('the lock file and the config file must stay outside every root', async () => {
  await withProject(async (project) => {
    const lockInCache = await layoutIssuesFor(project, {
      lockFile: '.cratepin-cache/cratepin-lock.json',
    });
    assert.deepEqual(issueSummaries(lockInCache), ['/lockFile: Must not be inside /cacheDir']);
  });
});

test('an output root that is a link to the project itself would swallow the config file', async () => {
  await withProject(async (project) => {
    await linkDirectory(project, join(project, 'project-alias'));
    const summaries = issueSummaries(
      await layoutIssuesFor(project, { outputDir: 'project-alias' }),
    );
    assert.ok(
      summaries.includes('/: The config file must not be inside /outputDir'),
      summaries.join('\n'),
    );
    assert.ok(summaries.includes('/lockFile: Must not be inside /outputDir'));
  });
});

test('a link in any ancestor that leads outside the project is rejected', async () => {
  await withProject(async (project, workspace) => {
    await mkdir(join(workspace, 'elsewhere'));
    await linkDirectory(join(workspace, 'elsewhere'), join(project, 'linked'));
    const escaping = await layoutIssuesFor(project, { outputDir: 'linked/assets' });
    assert.deepEqual(issueSummaries(escaping), [
      '/outputDir: Resolves outside the project directory through a symbolic link or junction',
    ]);
  });
});

test('a link inside the project cannot hide an overlap between roots', async () => {
  await withProject(async (project) => {
    await mkdir(join(project, 'assets', 'source'), { recursive: true });
    await linkDirectory(join(project, 'assets', 'source'), join(project, 'source-alias'));
    const hiddenOverlap = await layoutIssuesFor(project, { outputDir: 'source-alias/generated' });
    assert.deepEqual(issueSummaries(hiddenOverlap), [
      '/outputDir: Overlaps /sourceDir; each root needs its own directory',
    ]);
  });
});

test('roots must have the right kind and must not be links themselves', async () => {
  await withProject(async (project) => {
    await mkdir(join(project, 'public'));
    await writeFile(join(project, 'public', 'assets'), 'not a directory');
    await mkdir(join(project, 'cratepin-lock.json'));
    await mkdir(join(project, 'real-cache'));
    await linkDirectory(join(project, 'real-cache'), join(project, '.cratepin-cache'));
    assert.deepEqual(issueSummaries(await layoutIssuesFor(project, {})), [
      '/cacheDir: Is itself a symbolic link or junction; point the config at the real directory',
      '/outputDir: Exists but is a file, not a directory',
      '/lockFile: Exists but is a directory, not a file',
    ]);
  });
});

test('a broken link on the way to a root is reported instead of crashing', async () => {
  await withProject(async (project, workspace) => {
    const vanished = join(workspace, 'vanished');
    await mkdir(vanished);
    await linkDirectory(vanished, join(project, 'dangling'));
    await rm(vanished, { recursive: true });
    const issues = await layoutIssuesFor(project, { outputDir: 'dangling/assets' });
    assert.ok(
      issueSummaries(issues).includes(
        '/outputDir: Cannot be resolved: a link on the way is broken or a directory is unreadable',
      ),
    );
  });
});

test('the lock file can never be the config file itself', async () => {
  await withProject(async (project) => {
    const summaries = issueSummaries(
      await layoutIssuesFor(project, { lockFile: 'cratepin.config.json' }),
    );
    assert.ok(
      summaries.includes('/lockFile: Must not be the config file itself'),
      summaries.join('\n'),
    );
  });
});

test('a junction to a sibling that differs only by Unicode case form is still outside', async (context) => {
  await withWorkspace(async (workspace) => {
    const kelvinProject = join(workspace, 'Kproj');
    const asciiSibling = join(workspace, 'kproj');
    await mkdir(kelvinProject);
    try {
      await mkdir(asciiSibling);
    } catch {
      context.skip('this file system treats the Kelvin sign and k as one name');
      return;
    }
    await linkDirectory(asciiSibling, join(kelvinProject, 'link'));
    const summaries = issueSummaries(
      await layoutIssuesFor(kelvinProject, { outputDir: 'link/generated' }),
    );
    assert.deepEqual(summaries, [
      '/outputDir: Resolves outside the project directory through a symbolic link or junction',
    ]);
  });
});

test('a lock file hard-linked to the config file is detected', async () => {
  await withProject(async (project) => {
    await layoutIssuesFor(project, {});
    await link(join(project, 'cratepin.config.json'), join(project, 'cratepin-lock.json'));
    const summaries = issueSummaries(await layoutIssuesFor(project, {}));
    assert.ok(
      summaries.includes('/lockFile: Must not be the config file itself'),
      summaries.join('\n'),
    );
  });
});

test('a lock path that contains a root is reported as an overlap, not as being inside it', async () => {
  await withProject(async (project) => {
    const summaries = issueSummaries(
      await layoutIssuesFor(project, { lockFile: 'assets', sourceDir: 'assets/source' }),
    );
    assert.deepEqual(summaries, [
      '/lockFile: Overlaps /sourceDir; each root needs its own directory',
    ]);
  });
});

test('a junction cannot smuggle a root into node_modules or .git', async () => {
  await withProject(async (project) => {
    await mkdir(join(project, 'node_modules'));
    await mkdir(join(project, '.git'));
    await linkDirectory(join(project, 'node_modules'), join(project, 'deps'));
    await linkDirectory(join(project, '.git'), join(project, 'vcs'));
    const summaries = issueSummaries(
      await layoutIssuesFor(project, { outputDir: 'deps/out', cacheDir: 'vcs/cache' }),
    );
    assert.ok(
      summaries.includes('/outputDir: Must not be inside .git, .hg, .svn or node_modules'),
      summaries.join('\n'),
    );
    assert.ok(summaries.includes('/cacheDir: Must not be inside .git, .hg, .svn or node_modules'));
  });
});

test("a junction cannot lead the output or source root into a sibling root's work directory", async () => {
  await withProject(async (project) => {
    const siblingWork = join(project, 'public', '.other.CRATEPIN');
    await mkdir(join(siblingWork, 'source'), { recursive: true });
    await linkDirectory(siblingWork, join(project, 'linked'));
    const issues = await layoutIssuesFor(project, {
      sourceDir: 'linked/source',
      outputDir: 'linked/assets',
    });
    assert.deepEqual(issueSummaries(issues), [
      '/sourceDir: Must not be or lie in a directory named .<name>.cratepin, where builds stage, swap and remove output',
      '/outputDir: Must not be or lie in a directory named .<name>.cratepin, where builds stage, swap and remove output',
    ]);
  });
});

test('a project that itself lies in a work directory is refused: a sibling build would empty it', async () => {
  await withWorkspace(async (workspace) => {
    const project = join(workspace, '.assets.cratepin');
    await mkdir(project);
    const issues = await layoutIssuesFor(project, { sourceDir: 'staging' });
    assert.deepEqual(issueSummaries(issues), [
      '/sourceDir: Must not be or lie in a directory named .<name>.cratepin, where builds stage, swap and remove output',
      '/cacheDir: Must not be or lie in a directory named .<name>.cratepin, where builds stage, swap and remove output',
      '/outputDir: Must not be or lie in a directory named .<name>.cratepin, where builds stage, swap and remove output',
      '/lockFile: Must not be or lie in a directory named .<name>.cratepin, where builds stage, swap and remove output',
    ]);
  });
});

test('a junction cannot hide a root or the lock inside the build work directory', async () => {
  await withProject(async (project) => {
    const work = join(project, 'public', '.assets.cratepin');
    await mkdir(join(work, 'source'), { recursive: true });
    await linkDirectory(work, join(project, 'linked'));
    const issues = await layoutIssuesFor(project, {
      sourceDir: 'linked/source',
      lockFile: 'linked/cratepin-lock.json',
    });
    assert.deepEqual(issueSummaries(issues), [
      '/sourceDir: Must not be or lie in a directory named .<name>.cratepin, where builds stage, swap and remove output',
      '/lockFile: Must not be or lie in a directory named .<name>.cratepin, where builds stage, swap and remove output',
    ]);
  });
});
