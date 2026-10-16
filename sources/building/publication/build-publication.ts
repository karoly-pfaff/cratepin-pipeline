import { swapInStaging } from '../../output/publication/directory-swap.ts';
import { GENERATION_LISTING_NAME } from '../../output/generation/generation-listing.ts';
import { readGenerationListing } from '../../output/generation/listing-reading.ts';
import type { ToolFile } from '../../output/files/output-files.ts';
import { OUTPUT_MARKER_NAME, outputMarkerTextOf } from '../../output/ownership/output-marker.ts';
import { RUNTIME_MANIFEST_NAME } from '../../output/layout/output-paths.ts';
import { auditOutputTree } from '../../output/files/tree-audit.ts';
import { removeOwnStaging } from '../../output/files/tree-removal.ts';
import { removeEmptyWorkDirectory, workDirectoryOf } from '../../output/layout/work-directory.ts';
import type { WorkDirectory } from '../../output/layout/work-directory.ts';
import { ensureDirectory } from '../../paths/files/create-only-files.ts';
import { stageAudited } from './staged-publication.ts';
import type { Publication, PublicationResult } from './staged-publication.ts';

/** The tool files of an output tree: marker, listing and runtime manifest. */
function toolFilesOf({ project, assembled }: Publication): ToolFile[] {
  return [
    { name: OUTPUT_MARKER_NAME, text: outputMarkerTextOf(project.config) },
    { name: GENERATION_LISTING_NAME, text: assembled.listingText },
    { name: RUNTIME_MANIFEST_NAME, text: assembled.manifestText },
  ];
}

/** The published root already holds exactly this output, every byte checked: nothing to swap. */
async function isPublishedUnchanged(publication: Publication): Promise<boolean> {
  const root = publication.project.paths.outputRoot;
  const listing = await readGenerationListing(root);
  if (listing?.text !== publication.assembled.listingText) return false;
  const expected = { files: publication.assembled.files, toolFiles: toolFilesOf(publication) };
  return (await auditOutputTree(root, expected)).length === 0;
}

/** Writes and audits the complete next root in the work directory's staging. */
async function stageNextRoot(publication: Publication, work: WorkDirectory): Promise<void> {
  await ensureDirectory(work.directory);
  await stageAudited({ publication, staging: work.staging, toolFiles: toolFilesOf(publication) });
}

/** Runs `step`; on failure removes the staging (never published) before passing the error on. */
async function removingStagingOnFailure<Result>(
  publication: Publication,
  work: WorkDirectory,
  step: () => Promise<Result>,
): Promise<Result> {
  try {
    return await step();
  } catch (error) {
    await removeOwnStaging(publication.fileSystem, work.staging);
    await removeEmptyWorkDirectory(publication.fileSystem, work);
    throw error;
  }
}

/**
 * Publishes a path-preserving output: unless the published root already holds exactly this
 * output, the complete next root is staged next to it (marker, every output streamed from the
 * verified cache, listing, manifest), audited byte for byte and swapped in by two renames. A
 * failure before the commit removes the staging and leaves the previous output as it was.
 */
export async function publishPathPreserving(publication: Publication): Promise<PublicationResult> {
  if (await isPublishedUnchanged(publication)) {
    return { outcome: 'unchanged', notices: [], removedFileCount: 0 };
  }
  const work = workDirectoryOf(publication.project.paths.outputRoot);
  const { fileSystem, project, signal } = publication;
  const swap = await removingStagingOnFailure(publication, work, async () => {
    await stageNextRoot(publication, work);
    return swapInStaging({ fileSystem, work, owner: project.config, signal });
  });
  await removeEmptyWorkDirectory(fileSystem, work);
  return {
    outcome: 'published',
    notices: swap.notices,
    removedFileCount: swap.cleanup.removedFileCount,
  };
}
