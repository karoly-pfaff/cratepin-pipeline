import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { withTempDirectory } from '../support/cli-runs.test-support.mjs';

function storyOf(id, status) {
  return {
    id,
    title: `Behavior ${id}`,
    epic: 'E01',
    status,
    acceptance_criteria: [1, 2, 3].map((number) => `${id} condition ${String(number)}.`),
    verification: `${id} verification.`,
    evidence: status === 'done' ? [`Executed proof for ${id}.`] : [],
    requirements: ['R-01'],
    depends_on: [],
  };
}

function storyMarkdown(story) {
  return [
    `## ${story.id} — ${story.title}`,
    '',
    `**Status:** ${story.status}`,
    '',
    'Acceptance criteria:',
    '',
    ...story.acceptance_criteria.map((criterion) => `- ${criterion}`),
    '',
    `**Verification:** ${story.verification}`,
    '',
    '**Evidence:**',
    '',
    ...(story.evidence.length === 0 ? ['none'] : story.evidence.map((proof) => `- ${proof}`)),
    '',
  ].join('\n');
}

function fixtureOf() {
  const stories = [storyOf('S-001', 'done'), storyOf('S-002', 'planned')];
  return {
    plan: { schemaVersion: 1, epics: [{ id: 'E01', title: 'Fixture' }], stories },
    markdown: '# Fixture epic\n\n' + stories.map(storyMarkdown).join('\n'),
  };
}

function withFirstStoryChanged(fixture, changes) {
  const stories = fixture.plan.stories.map((story, index) =>
    index === 0 ? { ...story, ...changes } : story,
  );
  return { ...fixture, plan: { ...fixture.plan, stories } };
}

async function checkCopy(change, hasBacklog = true) {
  let checked;
  await withTempDirectory(async (directory) => {
    await cp(new URL('../../scripts/', import.meta.url), join(directory, 'scripts'), {
      recursive: true,
    });
    await mkdir(join(directory, '.local/docs'), { recursive: true });
    await writeFile(
      join(directory, '.local/docs/requirements.md'),
      '| R-01 | Fixture requirement |\n',
    );
    const fixture = change === undefined ? fixtureOf() : change(fixtureOf());
    if (hasBacklog) {
      await mkdir(join(directory, '.local/backlog'));
      await writeFile(join(directory, '.local/backlog/backlog.json'), JSON.stringify(fixture.plan));
      await writeFile(join(directory, '.local/backlog/e01.md'), fixture.markdown);
    }
    checked = spawnSync(process.execPath, [join(directory, 'scripts', 'check-plan.mjs')], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
  });
  assert.ok(checked);
  assert.equal(checked.error, undefined);
  return checked;
}

const MUTATIONS = [
  {
    name: 'JSON done versus Markdown planned',
    diagnostic: 'Status drift',
    change: (fixture) => ({
      ...fixture,
      markdown: fixture.markdown.replace('**Status:** done', '**Status:** planned'),
    }),
  },
  {
    name: 'verification drift',
    diagnostic: 'Verification drift',
    change: (fixture) => withFirstStoryChanged(fixture, { verification: 'Another verification.' }),
  },
  {
    name: 'evidence drift',
    diagnostic: 'Evidence drift',
    change: (fixture) => withFirstStoryChanged(fixture, { evidence: ['Another proof.'] }),
  },
  {
    name: 'missing Markdown evidence',
    diagnostic: 'Evidence drift',
    change: (fixture) => ({
      ...fixture,
      markdown: fixture.markdown.replace('- Executed proof for S-001.', 'none'),
    }),
  },
  {
    name: 'missing evidence field',
    diagnostic: 'Missing or duplicate Evidence',
    change: (fixture) => ({
      ...fixture,
      markdown: fixture.markdown.replace('**Evidence:**\n\n- Executed proof for S-001.', ''),
    }),
  },
  {
    name: 'done without JSON evidence',
    diagnostic: 'Missing evidence',
    change: (fixture) => withFirstStoryChanged(fixture, { evidence: [] }),
  },
  {
    name: 'blank JSON evidence',
    diagnostic: 'Invalid evidence',
    change: (fixture) => withFirstStoryChanged(fixture, { evidence: ['   '] }),
  },
  {
    name: 'non-list JSON evidence',
    diagnostic: 'Invalid evidence',
    change: (fixture) => withFirstStoryChanged(fixture, { evidence: 'Executed proof.' }),
  },
  {
    name: 'criteria present only in another story',
    diagnostic: 'Criteria drift',
    change: (fixture) => ({
      ...fixture,
      markdown: fixture.markdown
        .replace('- S-001 condition 1.\n', '')
        .replace(
          '**Verification:** S-002 verification.',
          '- S-001 condition 1.\n\n**Verification:** S-002 verification.',
        ),
    }),
  },
];

for (const mutation of MUTATIONS) {
  test(`work-plan copy refuses ${mutation.name}`, async () => {
    const checked = await checkCopy(mutation.change);
    assert.notEqual(checked.status, 0, checked.stdout + checked.stderr);
    assert.match(checked.stderr, new RegExp(`${mutation.diagnostic}.*S-001`, 'u'));
  });
}

test('a consistent isolated work plan passes', async () => {
  const checked = await checkCopy();
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /1 epics, 2 stories, 1 requirements/u);
});

test('wrapped Markdown text stays consistent with the same JSON text', async () => {
  const checked = await checkCopy((fixture) => ({
    ...fixture,
    markdown: fixture.markdown.replace('S-001 condition 1.', 'S-001\n  condition 1.'),
  }));
  assert.equal(checked.status, 0, checked.stderr);
});

test('a clean checkout without the private work plan skips legitimately', async () => {
  const checked = await checkCopy(undefined, false);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /work plan check skipped/u);
});
