import { PipelineError, toPipelineError } from '../../errors.ts';
import { isBlocked } from './publication-files.ts';

/** A program holds `path` open, so it could not be renamed; `outcome` says what became of it. */
function outputInUse(path: string, outcome: string): PipelineError {
  return new PipelineError(
    'OUTPUT_CONFLICT',
    `A program has a file in the output directory open (a dev server, an editor, Explorer, a terminal in it); ${outcome}. Close it and build again.`,
    { reason: 'OUTPUT_IN_USE', path },
  );
}

/**
 * Why a publication step on `path` (a swap, a placement, a manifest switch or their recovery)
 * failed: a program holding it open
 * (OUTPUT_IN_USE), or any other local failure as its own code, naming the path it reported
 * when it has one; `outcome` says what became of the output.
 */
export function publicationStepFailure(
  path: string,
  error: unknown,
  outcome: string,
): PipelineError {
  if (isBlocked(error)) return outputInUse(path, outcome);
  const failure = toPipelineError(error);
  return new PipelineError(
    failure.code,
    `${failure.message} A publication step failed; ${outcome}.`,
    { path, ...failure.details },
  );
}
