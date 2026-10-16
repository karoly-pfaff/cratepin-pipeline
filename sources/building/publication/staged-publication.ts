import { PipelineError } from '../../errors.ts';
import type { ToolFile } from '../../output/files/output-files.ts';
import type { PublicationFileSystem } from '../../output/publication/publication-files.ts';
import { auditOutputTree } from '../../output/files/tree-audit.ts';
import { assertLayoutStillSafe } from '../../paths/layout/checked-project.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import type { ReportIssue } from '../../report.ts';
import type { BuiltAsset } from '../assembly/asset-outputs.ts';
import type { AssembledOutput } from '../assembly/output-assembly.ts';
import { stageOutputTree } from '../assembly/staged-tree.ts';

/** One complete, assembled output to publish into the project's output root. */
export interface Publication {
  readonly fileSystem: PublicationFileSystem;
  readonly project: CheckedProject;
  readonly built: readonly BuiltAsset[];
  readonly assembled: AssembledOutput;
  readonly signal?: AbortSignal | undefined;
}

/**
 * `published` put the new output in place; `unchanged` found the published output already
 * identical. In generation mode, `previousGeneration` is the generation the replaced manifest
 * named, which is kept.
 */
export interface PublicationResult {
  readonly outcome: 'published' | 'unchanged';
  readonly notices: readonly ReportIssue[];
  readonly removedFileCount: number;
  readonly previousGeneration?: string;
}

/** A staged tree and the tool files it ends with. */
export interface StagedPublication {
  readonly publication: Publication;
  /** A directory that does not exist yet; this run creates it and alone writes to it. */
  readonly staging: string;
  readonly toolFiles: readonly ToolFile[];
}

async function auditStaging({ publication, staging, toolFiles }: StagedPublication): Promise<void> {
  const expected = { files: publication.assembled.files, toolFiles };
  const findings = await auditOutputTree(staging, expected);
  if (findings.length === 0) return;
  throw new PipelineError(
    'INTEGRITY_MISMATCH',
    'The staged output does not hold exactly what was built; nothing was published.',
    { reason: 'STAGED_TREE_INVALID', findingCount: findings.length },
  );
}

/**
 * Writes the complete next tree into a new staging directory (every output streamed from the
 * verified cache, then the tool files), audits it byte for byte against what was assembled
 * (STAGED_TREE_INVALID) and checks the project layout again; the caller removes the staging when
 * this fails.
 */
export async function stageAudited(staged: StagedPublication): Promise<void> {
  const { publication, staging, toolFiles } = staged;
  await publication.fileSystem.mkdir(staging);
  const { built, signal } = publication;
  await stageOutputTree({ directory: staging, built, toolFiles, signal });
  await auditStaging(staged);
  await assertLayoutStillSafe(publication.project, 'nothing was published');
}
