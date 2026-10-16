import { PipelineError } from '../../errors.ts';
import { ensureDirectory } from '../../paths/files/create-only-files.ts';
import { entryKindAt } from '../../paths/path-containment.ts';
import { generationDirectoryOf, generationTrashPathOf } from './generation-layout.ts';
import type { GenerationLayout } from './generation-layout.ts';
import { GENERATION_LISTING_NAME, generationNameOf } from './generation-listing.ts';
import type { ListedFile } from './generation-listing.ts';
import type { ActiveGeneration } from '../manifest/manifest-switch.ts';
import { renameWithRetry } from '../publication/publication-files.ts';
import type { PublicationFileSystem } from '../publication/publication-files.ts';
import { publicationStepFailure } from '../publication/publication-failures.ts';
import { auditOutputTree } from '../files/tree-audit.ts';

/** A staged, audited generation and where it goes. */
export interface GenerationPlacement extends GenerationContents {
  readonly fileSystem: PublicationFileSystem;
  readonly layout: GenerationLayout;
  readonly generation: string;
  /** The generation the published manifest names, which is never replaced. */
  readonly active: ActiveGeneration;
}

/** A generation's exact contents: its listing text and the files it lists. */
export interface GenerationContents {
  readonly listingText: string;
  readonly files: readonly ListedFile[];
}

/** Whether `directory` is a real directory holding exactly this generation, every byte checked. */
export async function isGenerationIntact(
  directory: string,
  { listingText, files }: GenerationContents,
): Promise<boolean> {
  if ((await entryKindAt(directory)) !== 'directory') return false;
  const toolFiles = [{ name: GENERATION_LISTING_NAME, text: listingText }];
  return (await auditOutputTree(directory, { files, toolFiles })).length === 0;
}

function isActiveName({ active, generation }: GenerationPlacement): boolean {
  return (
    active.state === 'present' &&
    generationNameOf(active.generation) === generationNameOf(generation)
  );
}

/** The published generation's directory holds something else: it is never replaced. */
function activeConflict(placement: GenerationPlacement, directory: string): PipelineError {
  const isSameDigest =
    placement.active.state === 'present' && placement.active.generation === placement.generation;
  return isSameDigest
    ? new PipelineError(
        'OUTPUT_CONFLICT',
        'The published generation was changed after it was published; it is generated, so delete its directory and build again.',
        { reason: 'GENERATION_DAMAGED', path: directory },
      )
    : new PipelineError(
        'OUTPUT_CONFLICT',
        'Another generation with the same short name is published; nothing was replaced. Build again after the next lock change, or delete the generation directory.',
        { reason: 'GENERATION_COLLISION', path: directory },
      );
}

async function renameStep(
  fileSystem: PublicationFileSystem,
  from: string,
  to: string,
): Promise<void> {
  try {
    await renameWithRetry(fileSystem, from, to);
  } catch (error) {
    throw publicationStepFailure(from, error, 'the previous manifest stays published');
  }
}

/** Moves an unpublished directory holding the name to the trash; the published one is refused. */
async function clearUnpublishedName(placement: GenerationPlacement, target: string): Promise<void> {
  if (isActiveName(placement)) throw activeConflict(placement, target);
  await ensureDirectory(placement.layout.trash);
  await renameStep(placement.fileSystem, target, generationTrashPathOf(placement.layout));
}

/**
 * Puts the staged generation at `generations/<name>`: into a free name; not at all when the same
 * generation is already there intact (it is reused); over an unpublished directory of that name,
 * which first moves to the trash; never over the published generation (GENERATION_DAMAGED or
 * GENERATION_COLLISION, exit 9). Nothing is ever overwritten, and the manifest is not touched.
 */
export async function placeGeneration(placement: GenerationPlacement): Promise<void> {
  const target = generationDirectoryOf(placement.layout, placement.generation);
  if ((await entryKindAt(target)) !== 'absent') {
    if (await isGenerationIntact(target, placement)) return;
    await clearUnpublishedName(placement, target);
  }
  await renameStep(placement.fileSystem, placement.layout.staging, target);
}
