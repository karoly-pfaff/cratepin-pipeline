import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The consumer CI template is read as text (the repository has no YAML parser): what a fork's
// pull request can reach must stay free of secrets, writer keys and uploads.

const TEMPLATE_URL = new URL('../../examples/vite-consumer/ci/game-build.yml', import.meta.url);

/** The template's lines without comments, which may name what the template must never do. */
async function templateLines() {
  const text = await readFile(TEMPLATE_URL, 'utf8');
  return text
    .split(/\r?\n/u)
    .map((line) => line.replace(/(^|\s)#.*$/u, '').trimEnd())
    .filter((line) => line.trim() !== '');
}

/** Pushes, and pull requests whose head is a branch of this repository. */
const TRUSTED_CONDITION =
  "github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository";
/** Pull requests whose head is in another repository: a fork. */
const FORK_CONDITION =
  "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository";

/** A job's exact `if:` condition: a weaker one could hand the trusted job to a fork. */
function conditionOf(job) {
  const conditions = job.filter((line) => line.trim().startsWith('if:'));
  assert.equal(conditions.length, 1);
  return conditions[0].trim().slice('if:'.length).trim();
}

/** The lines of one job: from its `  <name>:` line to the next job or the end. */
function jobLines(lines, name) {
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `job ${name}`);
  const next = lines.findIndex((line, index) => index > start && /^ {2}\S/u.test(line));
  return lines.slice(start, next === -1 ? undefined : next);
}

test('the CI template never runs with a fork trigger that gets secrets, nor writes or uploads', async () => {
  const text = (await templateLines()).join('\n');
  for (const forbidden of ['pull_request_target', 'workflow_run', 'R2_WRITE', 'push --', 'scan']) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
  assert.doesNotMatch(text, /cratepin push|assets:push/u);
  assert.match(text, /^permissions:\n {2}contents: read$/mu, 'read-only token at the top');
  const installs = text.split('\n').filter((line) => /npm (ci|install)/u.test(line));
  assert.equal(installs.length, 2, 'one install per job');
  for (const line of installs)
    assert.match(line, /npm ci --ignore-scripts$/u, 'no install scripts');
});

test('only the trusted job reads secrets; the fork job builds offline from a restored cache', async () => {
  const lines = await templateLines();
  const trusted = jobLines(lines, 'trusted');
  const fork = jobLines(lines, 'fork');
  const secretLines = lines.filter((line) => /secrets/u.test(line));
  assert.equal(secretLines.length, 4);
  assert.ok(secretLines.every((line) => trusted.includes(line)));
  assert.equal(conditionOf(trusted), TRUSTED_CONDITION);
  assert.equal(conditionOf(fork), FORK_CONDITION);
  assert.ok(!fork.some((line) => /secrets|environment:/u.test(line)));
  assert.ok(fork.some((line) => line.includes('actions/cache/restore@')));
  assert.ok(fork.some((line) => line.includes('assets:build:offline')));
  assert.ok(!fork.some((line) => line.includes('npm run build')), 'prebuild would read storage');
});

test('both dependency installs authenticate to GitHub Packages with only the job read token', async () => {
  const text = (await templateLines()).join('\n');
  assert.match(text, /^ {2}packages: read$/mu);
  assert.doesNotMatch(text, /packages: write|NODE_AUTH_TOKEN:.*secrets\./u);
  for (const name of ['trusted', 'fork']) {
    const job = jobLines(text.split('\n'), name).join('\n');
    assert.match(job, /registry-url: https:\/\/npm\.pkg\.github\.com/u);
    assert.match(job, /scope: '@karoly-pfaff'/u);
    assert.match(
      job,
      /npm ci --ignore-scripts\n {8}env:\n {10}NODE_AUTH_TOKEN: \$\{\{ github\.token \}\}/u,
    );
    assert.equal(job.match(/NODE_AUTH_TOKEN/gu)?.length, 1);
  }
});

/** The entries below each cache step's `path: |` line, step by step. */
function cachedPathsOf(lines) {
  const steps = [];
  lines.forEach((line, index) => {
    if (line.trim() !== 'path: |') return;
    const indent = line.search(/\S/u);
    const rest = lines.slice(index + 1);
    const end = rest.findIndex((next) => next.search(/\S/u) <= indent);
    steps.push(rest.slice(0, end).map((entry) => entry.trim()));
  });
  return steps;
}

test('the CI cache holds exactly the marker, originals and derivatives', async () => {
  const steps = cachedPathsOf(await templateLines());
  assert.equal(steps.length, 2);
  for (const paths of steps) {
    assert.deepEqual(paths, [
      '.cratepin-cache/cratepin-cache.json',
      '.cratepin-cache/originals',
      '.cratepin-cache/derivatives',
    ]);
  }
});
