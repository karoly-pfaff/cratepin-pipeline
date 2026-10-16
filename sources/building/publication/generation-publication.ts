import { throwIfCancelled } from '../../errors.ts';
import {
  generationDirectoryOf,
  generationLayoutOf,
} from '../../output/generation/generation-layout.ts';
import type { GenerationLayout } from '../../output/generation/generation-layout.ts';
import {
  GENERATION_LISTING_NAME,
  generationNameOf,
} from '../../output/generation/generation-listing.ts';
import {
  isGenerationIntact,
  placeGeneration,
} from '../../output/generation/generation-placement.ts';
import { retireGenerations } from '../../output/generation/generation-retention.ts';
import {
  manifestInvalidError,
  ownGenerationRoot,
  unknownNameNotices,
} from '../../output/generation/generation-root.ts';
import { readActiveGeneration, switchManifest } from '../../output/manifest/manifest-switch.ts';
import type { ActiveGeneration } from '../../output/manifest/manifest-switch.ts';
import { removeOwnStaging } from '../../output/files/tree-removal.ts';
import { assertLayoutStillSafe } from '../../paths/layout/checked-project.ts';
import { stageAudited } from './staged-publication.ts';
import type { Publication, PublicationResult } from './staged-publication.ts';

/** The published manifest is exactly this one and its generation is intact: nothing to do. */
async function isPublishedUnchanged(
  { assembled }: Publication,
  layout: GenerationLayout,
  active: ActiveGeneration,
): Promise<boolean> {
  if (active.state !== 'present' || active.text !== assembled.manifestText) return false;
  return isGenerationIntact(generationDirectoryOf(layout, assembled.generation), assembled);
}

/**
 * Stages the generation, audits it and puts it at its name (or reuses the intact one there);
 * the staging is removed whatever happens, and nothing is published yet.
 */
async function stageAndPlace(
  publication: Publication,
  layout: GenerationLayout,
  active: ActiveGeneration,
): Promise<void> {
  const { fileSystem, assembled } = publication;
  const toolFiles = [{ name: GENERATION_LISTING_NAME, text: assembled.listingText }];
  try {
    await stageAudited({ publication, staging: layout.staging, toolFiles });
    throwIfCancelled(publication.signal);
    await placeGeneration({ fileSystem, layout, ...assembled, active });
  } finally {
    await removeOwnStaging(fileSystem, layout.staging);
  }
}

/** The names of the generations that stay: the new one and the one the old manifest named. */
function keptNamesOf(generation: string, active: ActiveGeneration): Set<string> {
  const names = [generation, ...(active.state === 'present' ? [active.generation] : [])];
  return new Set(names.map((digest) => generationNameOf(digest)));
}

/** Owns the root, places the generation and switches the manifest to it: the commit. */
async function commitGeneration(
  publication: Publication,
  layout: GenerationLayout,
  active: ActiveGeneration,
): Promise<void> {
  const { fileSystem, project, assembled } = publication;
  await ownGenerationRoot(fileSystem, layout, project.config);
  await stageAndPlace(publication, layout, active);
  await assertLayoutStillSafe(project, 'the previous manifest stays published');
  await switchManifest(fileSystem, layout, assembled.manifestText);
}

/** Retires every generation but the new one and the one the replaced manifest named. */
async function retireAfterSwitch(
  { fileSystem, assembled }: Publication,
  layout: GenerationLayout,
  active: ActiveGeneration,
): Promise<Pick<PublicationResult, 'notices' | 'removedFileCount'>> {
  const keptNames = keptNamesOf(assembled.generation, active);
  return retireGenerations({ fileSystem, layout, keptNames });
}

/**
 * Publishes a generation-mode output inside its owned root, which never moves: unless the
 * published manifest already is this one with its generation intact, the root is created or
 * adopted with its marker, the generation is staged, audited and renamed into
 * `generations/<name>` (an intact one of that name is reused), then the root manifest is switched
 * to it in one step, the commit point. Until then the old manifest names its complete
 * generation. Afterwards every generation but the new one and the one the old manifest named is
 * retired. Ctrl+C is honoured until the generation is placed. A root manifest that is damaged
 * or not the tool's is never replaced (OUTPUT_MANIFEST_INVALID).
 */
export async function publishGeneration(publication: Publication): Promise<PublicationResult> {
  const layout = generationLayoutOf(publication.project.paths.outputRoot);
  const active = await readActiveGeneration(layout, publication.project.config);
  if (active.state === 'unreadable') throw manifestInvalidError(layout);
  if (await isPublishedUnchanged(publication, layout, active)) {
    return { outcome: 'unchanged', notices: await unknownNameNotices(layout), removedFileCount: 0 };
  }
  await commitGeneration(publication, layout, active);
  const retention = await retireAfterSwitch(publication, layout, active);
  return {
    outcome: 'published',
    notices: [...retention.notices, ...(await unknownNameNotices(layout))],
    removedFileCount: retention.removedFileCount,
    ...(active.state === 'present' ? { previousGeneration: active.generation } : {}),
  };
}
