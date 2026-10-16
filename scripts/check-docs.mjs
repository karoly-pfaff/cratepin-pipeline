import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The package gate also checks links inside the installed package, without source-tree fallback.
const REPOSITORY_ROOT = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL('../', import.meta.url));
// Scan maintained source docs, excluding dependencies, generated artifacts and private context.
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'build',
  'coverage',
  '.git',
  '.remember',
  '.local',
  '.cratepin-state',
  '.asset-pipeline-state',
  '.asset-cache',
]);
const MARKDOWN_LINK_TARGET = /\]\(([^)]+)\)/g;
const EXTERNAL_TARGET = /^[a-z]+:/;

async function listMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !SKIPPED_DIRECTORIES.has(entry.name))
      .map((entry) => markdownFilesFromEntry(join(directory, entry.name), entry)),
  );
  return nested.flat();
}

function markdownFilesFromEntry(path, entry) {
  if (entry.isDirectory()) return listMarkdownFiles(path);
  return Promise.resolve(entry.name.endsWith('.md') ? [path] : []);
}

function localLinkTargets(markdown) {
  return [...markdown.matchAll(MARKDOWN_LINK_TARGET)]
    .map((match) => match[1].split('#')[0])
    .filter((target) => target !== '' && !EXTERNAL_TARGET.test(target));
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function publicTargetExists(file, target) {
  const absolutePath = resolve(dirname(file), target);
  const rootSegment = relative(REPOSITORY_ROOT, absolutePath).split(sep)[0];
  if (rootSegment === '..' || SKIPPED_DIRECTORIES.has(rootSegment)) return false;
  return pathExists(absolutePath);
}

async function brokenLinksInFile(file) {
  const targets = localLinkTargets(await readFile(file, 'utf8'));
  const targetExists = await Promise.all(targets.map((target) => publicTargetExists(file, target)));
  return targets.filter((_, index) => !targetExists[index]).map((target) => `${file}: ${target}`);
}

const files = await listMarkdownFiles(REPOSITORY_ROOT);
const brokenLinks = (await Promise.all(files.map(brokenLinksInFile))).flat();
if (brokenLinks.length > 0) throw new Error(brokenLinks.join('\n'));
console.log('Relative documentation links pass.');
