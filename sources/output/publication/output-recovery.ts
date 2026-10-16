import type { ReportIssue } from '../../report.ts';

/**
 * What recovery did before a build: put the previous output back or finish a committed swap
 * (path-preserving mode only), or nothing beyond removing leftovers.
 */
export type RecoveryOutcome = 'none' | 'rolled-back' | 'completed';

/** What recovery did, the files it removed and the notices of what stayed. */
export interface RecoveryResult {
  readonly outcome: RecoveryOutcome;
  readonly notices: readonly ReportIssue[];
  readonly removedFileCount: number;
}
