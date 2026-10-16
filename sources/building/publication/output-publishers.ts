import type { PipelineError } from '../../errors.ts';
import { generationLayoutOf } from '../../output/generation/generation-layout.ts';
import {
  isRecoverable,
  pathPreservingWorkError,
  recoverGenerationRoot,
} from '../../output/generation/generation-recovery.ts';
import {
  assertGenerationRoot,
  generationRootError,
} from '../../output/generation/generation-root.ts';
import type { OutputRootState } from '../../output/ownership/output-marker.ts';
import { assertReplaceableRoot, ownedRootError } from '../../output/ownership/owned-root.ts';
import type { PublicationFileSystem } from '../../output/publication/publication-files.ts';
import { recoverWorkDirectory } from '../../output/publication/swap-recovery.ts';
import type { RecoveryResult } from '../../output/publication/output-recovery.ts';
import { workDirectoryRefusal } from '../../output/ownership/output-claim.ts';
import { workDirectoryOf } from '../../output/layout/work-directory.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import { entryKindAt } from '../../paths/path-containment.ts';
import { publishPathPreserving } from './build-publication.ts';
import { publishGeneration } from './generation-publication.ts';
import type { Publication, PublicationResult } from './staged-publication.ts';

/** How one output mode recovers, checks and publishes its owned root. */
export interface OutputPublisher {
  /** Finishes what an interrupted build left, before anything else touches the root. */
  readonly recover: (fileSystem: PublicationFileSystem) => Promise<RecoveryResult>;
  /** Throws the refusal when the root, after recovery, may not be published into. */
  readonly assertPublishable: () => Promise<void>;
  /** Why a root its marker allows may still not be published into, read only; for dry runs. */
  readonly rootRefusal: (state: OutputRootState) => Promise<PipelineError | undefined>;
  /** Whether an interrupted build left something a build would recover first; read only. */
  readonly hasLeftovers: () => Promise<boolean>;
  readonly publish: (publication: Publication) => Promise<PublicationResult>;
}

async function isAnyPresent(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) if ((await entryKindAt(path)) !== 'absent') return true;
  return false;
}

function pathPreservingPublisher(project: CheckedProject): OutputPublisher {
  const root = project.paths.outputRoot;
  const owner = project.config;
  const work = workDirectoryOf(root);
  return {
    recover: (fileSystem) => recoverWorkDirectory({ fileSystem, work, owner }),
    assertPublishable: async () => {
      await assertReplaceableRoot(root, owner);
    },
    rootRefusal: async (state) => (state.state === 'owned' ? ownedRootError(root) : undefined),
    hasLeftovers: () => isAnyPresent([work.directory]),
    publish: publishPathPreserving,
  };
}

function generationPublisher(project: CheckedProject): OutputPublisher {
  const layout = generationLayoutOf(project.paths.outputRoot);
  const work = workDirectoryOf(project.paths.outputRoot);
  return {
    recover: async (fileSystem) => {
      const leftWork = await pathPreservingWorkError(work);
      if (leftWork !== undefined) throw leftWork;
      return recoverGenerationRoot(fileSystem, layout, project.config);
    },
    assertPublishable: () => assertGenerationRoot(layout, project.config),
    rootRefusal: async () =>
      (await pathPreservingWorkError(work)) ?? generationRootError(layout, project.config),
    hasLeftovers: async () =>
      (await isAnyPresent([work.directory])) ||
      ((await isRecoverable(layout, project.config)) &&
        isAnyPresent([layout.staging, layout.trash, layout.manifestInProgress])),
    publish: publishGeneration,
  };
}

/**
 * The publisher of the project's output mode. Its read-only refusal names a link or file at the
 * work directory first, as the build claim meets it before anything else.
 */
export function outputPublisherOf(project: CheckedProject): OutputPublisher {
  const publisher =
    project.config.outputMode === 'generation'
      ? generationPublisher(project)
      : pathPreservingPublisher(project);
  return {
    ...publisher,
    rootRefusal: async (state) =>
      (await workDirectoryRefusal(project.paths.outputRoot)) ?? publisher.rootRefusal(state),
  };
}
