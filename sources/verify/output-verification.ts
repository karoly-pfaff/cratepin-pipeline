import { join } from 'node:path';

import { planBuild } from '../building/planning/build-plan.ts';
import { outputPublisherOf } from '../building/publication/output-publishers.ts';
import { PipelineError } from '../errors.ts';
import type { SourceLock } from '../lock/source-lock.ts';
import { generationLayoutOf } from '../output/generation/generation-layout.ts';
import { GENERATION_LISTING_NAME } from '../output/generation/generation-listing.ts';
import {
  generationsNotADirectoryError,
  isGenerationsUsable,
} from '../output/generation/generation-root.ts';
import type { PublishedListing } from '../output/generation/listing-reading.ts';
import { unsafeFileIssues, unsafeValueContextOf } from '../output/manifest/manifest-safety.ts';
import { MAX_TOOL_JSON_BYTES, readToolJson } from '../output/files/output-files.ts';
import { classifyOutputRoot } from '../output/ownership/output-marker.ts';
import { RUNTIME_MANIFEST_NAME } from '../output/layout/output-paths.ts';
import { outputRootError } from '../output/ownership/root-refusals.ts';
import type { CheckedProject } from '../paths/layout/checked-project.ts';
import type { ReportIssue } from '../report.ts';
import { imageDimensionIssues } from './image-dimensions.ts';
import { lockCoherenceIssues } from './lock-coherence.ts';
import { matchEntriesToFiles } from './manifest-entries.ts';
import { parsePublishedManifest } from './published-manifest.ts';
import type { ParsedManifest } from './published-manifest.ts';
import {
  manifestInvalid,
  publishedTreeOf,
  readNamedListing,
  treeIssuesOf,
} from './published-tree.ts';
import type { PublishedTree } from './published-tree.ts';
import { retainedGenerationIssues } from './retained-generations.ts';

/** What `verify` checks: the preflighted project and its committed lock. */
export interface VerificationRequest {
  readonly project: CheckedProject;
  readonly lock: SourceLock;
}

/** What `verify` found; any issue blocks packaging. */
export interface Verification {
  readonly manifestFile: string;
  readonly generation?: string;
  readonly assetCount: number;
  readonly fileCount: number;
  readonly byteCount: number;
  readonly issues: readonly ReportIssue[];
}

/** A manifest as read: its parsed form and exact text. */
interface ReadManifest {
  readonly manifest: ParsedManifest;
  readonly text: string;
}

/** The manifest when it is readable, and why it is not this project's when it is not. */
interface ManifestReading {
  readonly read?: ReadManifest;
  readonly issues: readonly ReportIssue[];
}

/** In generation mode, a link or file where the generations belong is refused, as a build does. */
async function assertGenerationsUsable(project: CheckedProject): Promise<void> {
  const layout = generationLayoutOf(project.paths.outputRoot);
  if (project.config.outputMode !== 'generation' || (await isGenerationsUsable(layout))) return;
  throw generationsNotADirectoryError(layout);
}

/**
 * The output root must be this project's, hold a publication and, in generation mode, keep its
 * generations in a real directory (as a build requires); else the refusal is thrown.
 */
async function assertPublishedRoot(project: CheckedProject): Promise<void> {
  const root = project.paths.outputRoot;
  const state = await classifyOutputRoot(root, project.config);
  const refusal = outputRootError(state, root);
  if (refusal !== undefined) throw refusal;
  if (state.state !== 'owned') {
    throw new PipelineError(
      'NOT_FOUND',
      'Nothing is published in the output directory; run build first.',
      { path: root },
    );
  }
  await assertGenerationsUsable(project);
}

async function leftoverIssues(project: CheckedProject): Promise<ReportIssue[]> {
  if (!(await outputPublisherOf(project).hasLeftovers())) return [];
  const message =
    'A build that was interrupted, or is still running, left work that would ship with the output; build again, which recovers it or says how to clear it.';
  return [{ path: project.paths.outputRoot, code: 'INTERRUPTED_PUBLICATION', message }];
}

/** The manifest, strictly read and in the tool's exact form for this project and mode. */
async function readManifest(
  project: CheckedProject,
  manifestFile: string,
): Promise<ManifestReading> {
  const reading = await readToolJson(manifestFile, MAX_TOOL_JSON_BYTES);
  const manifest =
    reading.state === 'parsed' ? parsePublishedManifest(reading.value, reading.text) : undefined;
  if (reading.state !== 'parsed' || manifest === undefined) {
    return {
      issues: [
        manifestInvalid(manifestFile, 'Missing, damaged or not in the form the tool writes.'),
      ],
    };
  }
  const { projectId, outputMode } = manifest.header;
  const isOwn = projectId === project.config.projectId && outputMode === project.config.outputMode;
  const issues = isOwn
    ? []
    : [manifestInvalid(manifestFile, 'Written for another project or output mode.')];
  return { read: { manifest, text: reading.text }, issues };
}

/** Every check of a readable manifest against its tree, the lock, the config and the scan. */
async function publicationIssues(
  request: VerificationRequest,
  read: ReadManifest,
  published: { readonly tree: PublishedTree; readonly listing: PublishedListing },
): Promise<ReportIssue[]> {
  const { project, lock } = request;
  const { tree, listing } = published;
  const { entries } = read.manifest;
  const match = matchEntriesToFiles({
    entries,
    files: listing.files,
    outputUrlPath: project.config.outputUrlPath,
    prefix: tree.prefix,
  });
  const plan = planBuild(project.config, lock);
  const context = unsafeValueContextOf(project);
  const treeIssues = await treeIssuesOf(tree, listing);
  return [
    ...treeIssues,
    ...(treeIssues.length === 0
      ? await imageDimensionIssues({ tree, entries, filesById: match.filesById })
      : []),
    ...match.issues,
    ...plan.issues,
    ...lockCoherenceIssues({ entries, filesById: match.filesById, plan, lock }),
    ...unsafeFileIssues(RUNTIME_MANIFEST_NAME, read.text, context),
    ...unsafeFileIssues(`${tree.prefix}${GENERATION_LISTING_NAME}`, listing.text, context),
  ];
}

/** In generation mode, the retained generations and unknown entries; nothing otherwise. */
function retainedIssuesOf(project: CheckedProject, generation: string): Promise<ReportIssue[]> {
  if (project.config.outputMode !== 'generation') return Promise.resolve([]);
  const layout = generationLayoutOf(project.paths.outputRoot);
  return retainedGenerationIssues({
    layout,
    publishedGeneration: generation,
    context: unsafeValueContextOf(project),
  });
}

/** Everything checked once the manifest is readable: its listing, tree, entries and the rest. */
async function verifyManifest(
  request: VerificationRequest,
  read: ReadManifest,
  manifestFile: string,
): Promise<Verification> {
  const { generation } = read.manifest.header;
  const tree = publishedTreeOf(request.project, read.manifest, read.text);
  const named = await readNamedListing(tree.directory, generation);
  const { listing } = named;
  const published =
    listing === undefined ? [] : await publicationIssues(request, read, { tree, listing });
  const files = listing?.files ?? [];
  return {
    manifestFile,
    generation,
    assetCount: read.manifest.entries.length,
    fileCount: files.length,
    byteCount: files.reduce((total, file) => total + file.bytes, 0),
    issues: [
      ...named.issues,
      ...published,
      ...(await retainedIssuesOf(request.project, generation)),
    ],
  };
}

/**
 * Audits the published output before packaging, reading only: no claim, no download, no
 * credential. The root must be this project's and hold a publication; nothing an interrupted
 * build left may be there; the manifest must be exactly what the tool writes for this project
 * and mode; its tree must hold exactly the listed files, every byte and image type checked; every
 * declared image size must match its published header, without decoding or re-encoding; every
 * entry must describe its file and agree with the committed lock and the current profiles; and
 * nothing in the manifest or listing may be unsafe to ship. In generation mode the retained
 * generations are audited too and unknown entries block.
 */
export async function verifyOutput(request: VerificationRequest): Promise<Verification> {
  const { project } = request;
  await assertPublishedRoot(project);
  const manifestFile = join(project.paths.outputRoot, RUNTIME_MANIFEST_NAME);
  const leftovers = await leftoverIssues(project);
  const { read, issues } = await readManifest(project, manifestFile);
  const empty = { manifestFile, assetCount: 0, fileCount: 0, byteCount: 0, issues: [] };
  const verified = read === undefined ? empty : await verifyManifest(request, read, manifestFile);
  return { ...verified, issues: [...leftovers, ...issues, ...verified.issues] };
}
