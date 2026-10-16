import { realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';

import { configIssue } from '../../config/rules/field-rules.ts';
import type { ConfigIssue } from '../../config/pipeline-config.ts';
import type { ProjectPaths } from '../../config/project-config.ts';
import {
  couldContainOnAnyPlatform,
  couldOverlapOnAnyPlatform,
  entryKindAt,
  fileIdentityOf,
  isRealPathSameOrInside,
  resolveRealLocation,
} from '../path-containment.ts';
import type { EntryKind } from '../path-containment.ts';
import { hasProtectedDirectorySegment } from '../portable-path.ts';
import { insideRootMessage, overlapMessage, PROTECTED_DIRECTORY_MESSAGE } from './root-messages.ts';
import { realWorkDirectoryIssues } from './work-directory-layout.ts';

type ExpectedKind = 'directory' | 'file';

/** One configured location: a root directory or a committed project file. */
interface ProjectLocation {
  readonly issuePath: string;
  readonly location: keyof ProjectPaths;
  readonly expectedKind: ExpectedKind;
}

interface ProjectFile extends ProjectLocation {
  readonly insideRootMessage: (rootPath: string) => string;
}

interface ResolvedLocation extends ProjectLocation {
  readonly realLocation: string | undefined;
  readonly entryKind: EntryKind;
  readonly fileIdentity: string | undefined;
}

/** Directories the tool reads, caches or replaces; none may contain another. */
const ROOT_DIRECTORIES: readonly ProjectLocation[] = [
  { issuePath: '/sourceDir', location: 'sourceRoot', expectedKind: 'directory' },
  { issuePath: '/cacheDir', location: 'cacheRoot', expectedKind: 'directory' },
  { issuePath: '/outputDir', location: 'outputRoot', expectedKind: 'directory' },
];

const LOCK_FILE: ProjectFile = {
  issuePath: '/lockFile',
  location: 'lockFilePath',
  expectedKind: 'file',
  insideRootMessage,
};
/** The config file has no field of its own, so its issues sit at `/` with a self-explaining text. */
const CONFIG_FILE: ProjectFile = {
  issuePath: '/',
  location: 'configFilePath',
  expectedKind: 'file',
  insideRootMessage: (rootPath) => `The config file must not be inside ${rootPath}`,
};

async function resolveLocation<Definition extends ProjectLocation>(
  paths: ProjectPaths,
  definition: Definition,
): Promise<ResolvedLocation & Definition> {
  const location = paths[definition.location];
  const [entryKind, fileIdentity] = await Promise.all([
    entryKindAt(location),
    fileIdentityOf(location),
  ]);
  try {
    return {
      ...definition,
      entryKind,
      fileIdentity,
      realLocation: await resolveRealLocation(location),
    };
  } catch {
    return { ...definition, entryKind, fileIdentity, realLocation: undefined };
  }
}

function containmentIssues(projectRoot: string, resolved: ResolvedLocation): ConfigIssue[] {
  if (resolved.realLocation === undefined) {
    return [
      configIssue(
        resolved.issuePath,
        'Cannot be resolved: a link on the way is broken or a directory is unreadable',
      ),
    ];
  }
  if (isRealPathSameOrInside(projectRoot, resolved.realLocation)) return [];
  return [
    configIssue(
      resolved.issuePath,
      'Resolves outside the project directory through a symbolic link or junction',
    ),
  ];
}

const UNEXPECTED_ENTRY_MESSAGES: Readonly<Record<ExpectedKind, ReadonlyMap<EntryKind, string>>> = {
  directory: new Map([
    ['file', 'Exists but is a file, not a directory'],
    ['other', 'Exists but is not a directory'],
    ['unreadable', 'Exists but cannot be inspected'],
    [
      'symbolic-link',
      'Is itself a symbolic link or junction; point the config at the real directory',
    ],
  ]),
  file: new Map([
    ['directory', 'Exists but is a directory, not a file'],
    ['other', 'Exists but is not a regular file'],
    ['unreadable', 'Exists but cannot be inspected'],
    ['symbolic-link', 'Is itself a symbolic link or junction; point the config at the real file'],
  ]),
};

function entryKindIssues(resolved: ResolvedLocation): ConfigIssue[] {
  const message = UNEXPECTED_ENTRY_MESSAGES[resolved.expectedKind].get(resolved.entryKind);
  return message === undefined ? [] : [configIssue(resolved.issuePath, message)];
}

type RealLocationPair = readonly [string, string];

/** Both real locations, or `undefined` when either could not be resolved (already reported). */
function realLocationPair(
  first: ResolvedLocation,
  second: ResolvedLocation,
): RealLocationPair | undefined {
  const { realLocation: firstLocation } = first;
  const { realLocation: secondLocation } = second;
  return firstLocation === undefined || secondLocation === undefined
    ? undefined
    : [firstLocation, secondLocation];
}

function rootOverlapIssues(roots: readonly ResolvedLocation[]): ConfigIssue[] {
  return roots.flatMap((root, index) =>
    roots
      .slice(0, index)
      .filter((earlierRoot) => {
        const pair = realLocationPair(earlierRoot, root);
        return pair !== undefined && couldOverlapOnAnyPlatform(...pair);
      })
      .map((earlierRoot) => configIssue(root.issuePath, overlapMessage(earlierRoot.issuePath))),
  );
}

/** A project file inside a root would be replaced or pruned; a file path containing a root is a mix-up. */
function fileVersusRootIssues(
  file: ResolvedLocation & ProjectFile,
  root: ResolvedLocation,
): ConfigIssue[] {
  const pair = realLocationPair(file, root);
  if (pair === undefined) return [];
  const [fileLocation, rootLocation] = pair;
  if (couldContainOnAnyPlatform(rootLocation, fileLocation)) {
    return [configIssue(file.issuePath, file.insideRootMessage(root.issuePath))];
  }
  if (!couldContainOnAnyPlatform(fileLocation, rootLocation)) return [];
  return [configIssue(file.issuePath, overlapMessage(root.issuePath))];
}

/** The lock file must never be the config file, neither through a symbolic link nor a hard link. */
function lockIsConfigIssues(
  lockFile: ResolvedLocation,
  configFile: ResolvedLocation,
): ConfigIssue[] {
  const pair = realLocationPair(lockFile, configFile);
  const isSamePath = pair !== undefined && pair[0] === pair[1];
  const isSameFile =
    lockFile.fileIdentity !== undefined && lockFile.fileIdentity === configFile.fileIdentity;
  return isSamePath || isSameFile
    ? [configIssue(lockFile.issuePath, 'Must not be the config file itself')]
    : [];
}

/** A root whose real location lies in `.git` or `node_modules`, e.g. reached through a junction. */
function protectedRealLocationIssues(projectRoot: string, root: ResolvedLocation): ConfigIssue[] {
  if (root.realLocation === undefined) return [];
  const projectRelative = relative(projectRoot, root.realLocation).split(sep).join('/');
  if (!hasProtectedDirectorySegment(projectRelative)) return [];
  return [configIssue(root.issuePath, PROTECTED_DIRECTORY_MESSAGE)];
}

/**
 * Checks the real file system as a preflight: every location resolves inside the project
 * (compared exactly on real paths), is not itself a link, has the expected kind, no root can
 * destroy another, and the committed files stay out of every root.
 */
export async function projectLayoutIssues(paths: ProjectPaths): Promise<ConfigIssue[]> {
  const projectRoot = await realpath(paths.configDirectory);
  const roots = await Promise.all(
    ROOT_DIRECTORIES.map((definition) => resolveLocation(paths, definition)),
  );
  const [lockFile, configFile] = await Promise.all([
    resolveLocation(paths, LOCK_FILE),
    resolveLocation(paths, CONFIG_FILE),
  ]);
  const allLocations = [...roots, lockFile, configFile];
  return [
    ...allLocations.flatMap((resolved) => containmentIssues(projectRoot, resolved)),
    ...allLocations.flatMap(entryKindIssues),
    ...rootOverlapIssues(roots),
    ...roots.flatMap((root) => protectedRealLocationIssues(projectRoot, root)),
    ...roots.flatMap((root) => [
      ...fileVersusRootIssues(lockFile, root),
      ...fileVersusRootIssues(configFile, root),
    ]),
    ...lockIsConfigIssues(lockFile, configFile),
    ...realWorkDirectoryIssues([...roots, lockFile]),
  ];
}
