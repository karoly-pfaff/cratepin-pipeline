import type { ErrorCode, ErrorDetails, PipelineError } from './errors.ts';
import { redactSecrets } from './redaction.ts';
import type { RedactionContext } from './redaction.ts';

/** One row of a listing, such as a source file with its hash and size. */
export type ReportRecord = Readonly<Record<string, string | number | boolean | readonly string[]>>;
export type ReportValue = string | number | boolean | readonly string[] | readonly ReportRecord[];
export type ReportFacts = Readonly<Record<string, ReportValue>>;

export interface ReportIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ReportedError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly isRetryable: boolean;
  readonly exitCode: number;
  readonly details: ErrorDetails;
}

/** The single source for what a command tells the user; text and JSON are two renderings of it. */
export interface OperationReport {
  readonly command: string;
  readonly status: 'succeeded' | 'failed';
  readonly facts: ReportFacts;
  readonly issues: readonly ReportIssue[];
  readonly error?: ReportedError;
}

/** What a failed operation still knows, e.g. counts done before the failure or orphaned keys. */
export interface FailureContext {
  readonly facts?: ReportFacts;
  readonly issues?: readonly ReportIssue[];
}

const SUCCESS_EXIT_CODE = 0;
const CONTROL_CHARACTER = /\p{Cc}/gu;

/** `notices` are findings that did not stop the operation, e.g. two files with equal bytes. */
export function succeededReport(
  command: string,
  facts: ReportFacts,
  notices: readonly ReportIssue[] = [],
): OperationReport {
  return { command, status: 'succeeded', facts, issues: notices };
}

export function failedReport(
  command: string,
  error: PipelineError,
  context: FailureContext = {},
): OperationReport {
  const { code, message, isRetryable, exitCode, details } = error;
  return {
    command,
    status: 'failed',
    facts: context.facts ?? {},
    issues: context.issues ?? [],
    error: { code, message, isRetryable, exitCode, details },
  };
}

export function exitCodeOf(report: OperationReport): number {
  return report.error?.exitCode ?? SUCCESS_EXIT_CODE;
}

/**
 * Applies `redactText` to every string value in a JSON-like value. Field names are chosen by
 * code and stay as they are, so two fields can never collapse into one redacted name.
 */
function redactStrings<Value>(value: Value, redactText: (text: string) => string): Value {
  if (typeof value === 'string') return redactText(value) as Value;
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map((item) => redactStrings(item, redactText)) as Value;
  }
  if (value === null || typeof value !== 'object') return value;
  const fields = value as Readonly<Record<string, unknown>>;
  const entries = Object.entries(fields).map(([key, item]) => [
    key,
    redactStrings(item, redactText),
  ]);
  return Object.fromEntries(entries) as Value;
}

function redactReport(report: OperationReport, redaction: RedactionContext): OperationReport {
  return redactStrings(report, (text) => redactSecrets(text, redaction));
}

/** One rendered line per value: control characters such as newlines are shown escaped. */
function escapeControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTER, (character) => JSON.stringify(character).slice(1, -1));
}

function isRecordList(value: ReportValue): value is readonly ReportRecord[] {
  return Array.isArray(value) && value.some((item) => typeof item === 'object');
}

function formatValue(value: Exclude<ReportValue, readonly ReportRecord[]>): string {
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  return escapeControlCharacters(text);
}

/** A listing row on its own indented line: `    - path: a.png, bytes: 12`. */
function recordLine(record: ReportRecord): string {
  const fields = Object.entries(record).map(([name, value]) =>
    Array.isArray(value) ? `${name}: [${value.join(', ')}]` : `${name}: ${String(value)}`,
  );
  return `    - ${escapeControlCharacters(fields.join(', '))}`;
}

function factLines(facts: ReportFacts): string[] {
  return Object.entries(facts).flatMap(([name, value]) => {
    const label = `  ${escapeControlCharacters(name)}:`;
    return isRecordList(value)
      ? [label, ...value.map(recordLine)]
      : [`${label} ${formatValue(value)}`];
  });
}

function errorLines(error: ReportedError | undefined): string[] {
  if (!error) return [];
  return [
    `  error ${error.code}: ${escapeControlCharacters(error.message)}`,
    `  retryable: ${error.isRetryable ? 'yes' : 'no'}`,
    ...factLines(error.details),
  ];
}

function issueLines(issues: readonly ReportIssue[]): string[] {
  return issues.map(
    (issue) => `  ${issue.code} at ${formatValue(issue.path)}: ${formatValue(issue.message)}`,
  );
}

export function renderReportAsText(report: OperationReport, redaction: RedactionContext): string {
  const redacted = redactReport(report, redaction);
  return [
    `${escapeControlCharacters(redacted.command)}: ${redacted.status}`,
    ...factLines(redacted.facts),
    ...errorLines(redacted.error),
    ...issueLines(redacted.issues),
  ].join('\n');
}

export function renderReportAsJson(report: OperationReport, redaction: RedactionContext): string {
  return JSON.stringify(redactReport(report, redaction), null, 2);
}
