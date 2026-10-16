import { configIssue } from '../../config/rules/field-rules.ts';
import type { ConfigIssue } from '../../config/pipeline-config.ts';
import { hasWorkDirectorySegment } from './output-work-directory.ts';
import { WORK_DIRECTORY_MESSAGE } from './root-messages.ts';

/** A configured location with its real path, once links are resolved (`undefined` if broken). */
interface RealLocation {
  readonly issuePath: string;
  readonly realLocation: string | undefined;
}

/**
 * No root and no lock may lie in a work directory, the project's own or a sibling root's, also
 * when a link leads there or the whole project lies in one: builds move and remove what their
 * recovery finds in it.
 */
export function realWorkDirectoryIssues(locations: readonly RealLocation[]): ConfigIssue[] {
  return locations
    .filter(
      ({ realLocation }) => realLocation !== undefined && hasWorkDirectorySegment(realLocation),
    )
    .map((location) => configIssue(location.issuePath, WORK_DIRECTORY_MESSAGE));
}
