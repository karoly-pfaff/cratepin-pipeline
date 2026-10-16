import { PipelineError } from '../../errors.ts';
import type { ReportIssue } from '../../report.ts';
import type { OutputRootState } from './output-marker.ts';
import { OUTPUT_MARKER_NAME } from './output-marker.ts';

/** Why a build must not touch the output root, with the remedy. */
interface RootRefusal {
  readonly code: string;
  readonly message: string;
}

const MIGRATION =
  'move it aside (for example to a sibling ending in .legacy) and build again, then compare and delete the old copy deliberately';

/** For each state a build must not touch, the refusal it gets; the other states may be built into. */
type RefusalBuilders = {
  readonly [State in OutputRootState as State['state']]?: (state: State) => RootRefusal;
};

const REFUSALS: RefusalBuilders = {
  'parent-missing': () => ({
    code: 'OUTPUT_PARENT_MISSING',
    message: "The output directory's parent does not exist; the tool never creates it.",
  }),
  'not-a-directory': ({ path }) => ({
    code: 'OUTPUT_NOT_A_DIRECTORY',
    message: `${path} is a link, junction or file where a real directory must be; nothing is built through it.`,
  }),
  'not-owned': ({ names, nameCount }) => ({
    code: 'OUTPUT_NOT_OWNED',
    message: `The output directory has content but no ${OUTPUT_MARKER_NAME}, so it is not this tool's output (${String(nameCount)} entries, e.g. ${names.join(', ')}); ${MIGRATION}.`,
  }),
  'foreign-project': ({ markedProjectId }) => ({
    code: 'OUTPUT_FOREIGN_PROJECT',
    message: `The output directory belongs to project "${markedProjectId}"; choose another outputDir.`,
  }),
  'mode-changed': ({ markedMode }) => ({
    code: 'OUTPUT_MODE_CHANGED',
    message: `The output directory was built in ${markedMode} mode; it is generated, so move or delete it and build again.`,
  }),
  'marker-invalid': () => ({
    code: 'OUTPUT_MARKER_INVALID',
    message: `The output directory's ${OUTPUT_MARKER_NAME} is unreadable or not this tool's; ${MIGRATION}.`,
  }),
};

function refusalOf(state: OutputRootState): RootRefusal | undefined {
  const build = REFUSALS[state.state] as ((of: OutputRootState) => RootRefusal) | undefined;
  return build?.(state);
}

/** The issue that keeps a build from this output root, or `undefined` when it may build. */
export function outputRootIssue(
  state: OutputRootState,
  outputRoot: string,
): ReportIssue | undefined {
  const refusal = refusalOf(state);
  return refusal === undefined ? undefined : { path: outputRoot, ...refusal };
}

/**
 * The error a build fails with at this output root: NOT_FOUND (exit 10) when its parent is
 * missing, OUTPUT_CONFLICT (exit 9) when it is not this project's real output directory.
 */
export function outputRootError(
  state: OutputRootState,
  outputRoot: string,
): PipelineError | undefined {
  const refusal = refusalOf(state);
  if (refusal === undefined) return undefined;
  const code = state.state === 'parent-missing' ? 'NOT_FOUND' : 'OUTPUT_CONFLICT';
  return new PipelineError(code, refusal.message, { reason: refusal.code, path: outputRoot });
}
