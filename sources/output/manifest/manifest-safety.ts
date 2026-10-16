import { PipelineError } from '../../errors.ts';
import { isJsonObject } from '../../json/strict-json.ts';
import type { CheckedProject } from '../../paths/layout/checked-project.ts';
import { CREDENTIAL_TOKEN_PATTERNS, SIGNED_URL_QUERY_PARAMETER } from '../../redaction.ts';
import type { ReportIssue } from '../../report.ts';
import { RUNTIME_MANIFEST_NAME } from '../layout/output-paths.ts';

/** What a value of this project must never contain anywhere: its storage address. */
export interface UnsafeValueContext {
  readonly storageAddresses: readonly string[];
}

/**
 * The project's public storage address (the host name of `publicBaseUrl`, without a port), which
 * must never ship. Its
 * absolute directories need no entry: any absolute path is refused by its shape, and a directory
 * name inside a relative path (`/app` in `assets/app/x.png`) is no leak.
 */
export function unsafeValueContextOf(project: CheckedProject): UnsafeValueContext {
  const read = project.config.r2.read;
  if (read.transport !== 'public-http' || !URL.canParse(read.publicBaseUrl)) {
    return { storageAddresses: [] };
  }
  return { storageAddresses: [new URL(read.publicBaseUrl).hostname] };
}

/** Shapes that never belong in a shipped manifest or listing, whatever the field. */
const UNSAFE_SHAPES: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  ...CREDENTIAL_TOKEN_PATTERNS.map((pattern) => ({ pattern, what: 'a credential' })),
  { pattern: /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u, what: 'an absolute path' },
  { pattern: /\\/u, what: 'a backslash' },
  { pattern: /:\/\//u, what: 'a URL with a scheme' },
  { pattern: /(?:^|\/)\.\.(?:\/|$)/u, what: 'a parent-directory segment' },
];

/** A signed storage URL's query; only where a query starts, so file names stay free. */
function isSignedUrlLike(text: string): boolean {
  return text.includes('?') && SIGNED_URL_QUERY_PARAMETER.test(text);
}

/** In a URL every name is percent-encoded, so a raw query, fragment or user part is not the tool's. */
const UNSAFE_URL_SHAPE = /[?#@]/u;

function unsafeIssue(pointer: string, what: string): ReportIssue {
  return {
    path: pointer === '' ? '/' : pointer,
    code: 'MANIFEST_UNSAFE_VALUE',
    message: `Holds ${what}; a shipped manifest or listing holds only relative public paths and plain facts.`,
  };
}

/** Characters that may continue a host name, so a match must not touch them on either side. */
const HOST_CHARACTER = /[a-z0-9.-]/iu;

function isHostBoundary(character: string | undefined): boolean {
  return character === undefined || !HOST_CHARACTER.test(character);
}

/** Whether `text` names `address` as a whole host, not as part of a longer name. */
function namesHost(text: string, address: string): boolean {
  const lowered = text.toLowerCase();
  const host = address.toLowerCase();
  for (let at = lowered.indexOf(host); at !== -1; at = lowered.indexOf(host, at + 1)) {
    if (isHostBoundary(lowered[at - 1]) && isHostBoundary(lowered[at + host.length])) return true;
  }
  return false;
}

function holdsStorageAddress(text: string, context: UnsafeValueContext): boolean {
  return context.storageAddresses.some((address) => namesHost(text, address));
}

/** What makes one string unsafe at `pointer` (its field is the pointer's last segment). */
function unsafeTextIssues(
  text: string,
  pointer: string,
  context: UnsafeValueContext,
): ReportIssue[] {
  const shapes = UNSAFE_SHAPES.filter(({ pattern }) => pattern.test(text)).map(({ what }) => what);
  const signed = isSignedUrlLike(text) ? ['a signed-URL parameter'] : [];
  const isUrlField = pointer.endsWith('/url');
  const urlShape =
    isUrlField && UNSAFE_URL_SHAPE.test(text) ? ['a query, fragment or user part'] : [];
  const address = holdsStorageAddress(text, context) ? ['the storage address'] : [];
  return [...shapes, ...signed, ...urlShape, ...address].map((what) => unsafeIssue(pointer, what));
}

/** Whether a URL carries a user name or password, which is a credential wherever it appears. */
function hasUrlUserInfo(text: string): boolean {
  if (!URL.canParse(text)) return false;
  const url = new URL(text);
  return url.username !== '' || url.password !== '';
}

/** Keys that may carry a secret: a credential shape, URL user info or a signed-URL query. */
function isSecretKey(key: string): boolean {
  const isToken = CREDENTIAL_TOKEN_PATTERNS.some((pattern) => pattern.test(key));
  return isToken || hasUrlUserInfo(key) || isSignedUrlLike(key);
}

/** A key as a JSON pointer segment; a key that may carry a secret is never echoed (a hex ID is). */
function pointerSegmentOf(key: string): string {
  const segment = isSecretKey(key) ? '[REDACTED]' : key;
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * Every string of a parsed manifest or listing, keys included, that must never ship: a
 * credential, an absolute path or backslash, a URL with a scheme, a parent-directory segment, a
 * signed-URL query, a raw query, fragment or user part in a `url`, or the project's storage
 * address. Hex digests are fine. Reported by JSON pointer; neither a value nor a
 * credential-shaped key is echoed.
 */
export function unsafeValueIssues(
  value: unknown,
  context: UnsafeValueContext,
  pointer = '',
): ReportIssue[] {
  if (typeof value === 'string') return unsafeTextIssues(value, pointer, context);
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown, index) =>
      unsafeValueIssues(item, context, `${pointer}/${String(index)}`),
    );
  }
  if (!isJsonObject(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const itemPointer = `${pointer}/${pointerSegmentOf(key)}`;
    return [
      ...unsafeTextIssues(key, `${itemPointer}#key`, context),
      ...unsafeValueIssues(item, context, itemPointer),
    ];
  });
}

/** The unsafe values of one shipped JSON file, each path naming the file: `<file>#<pointer>`. */
export function unsafeFileIssues(
  file: string,
  text: string,
  context: UnsafeValueContext,
): ReportIssue[] {
  return unsafeValueIssues(JSON.parse(text), context).map((issue) => ({
    ...issue,
    path: `${file}#${issue.path}`,
  }));
}

/** An assembled manifest and listing, as a build would publish them. */
export interface AssembledTexts {
  readonly manifestText: string;
  readonly listingText: string;
  /** The listing's path below the output root: in generation mode inside its generation. */
  readonly listingPath: string;
}

/** The unsafe values of an assembled manifest and listing, each naming its file. */
export function unsafeOutputIssues(
  texts: AssembledTexts,
  context: UnsafeValueContext,
): ReportIssue[] {
  return [
    ...unsafeFileIssues(RUNTIME_MANIFEST_NAME, texts.manifestText, context),
    ...unsafeFileIssues(texts.listingPath, texts.listingText, context),
  ];
}

/**
 * Why an assembled manifest and listing must not be published, or `undefined`: anything the
 * scan flags fails the build as INVALID_DATA (MANIFEST_UNSAFE_VALUE), naming the first place.
 */
export function unsafeOutputError(
  texts: AssembledTexts,
  context: UnsafeValueContext,
): PipelineError | undefined {
  const issues = unsafeOutputIssues(texts, context);
  const [first] = issues;
  if (first === undefined) return undefined;
  return new PipelineError(
    'INVALID_DATA',
    `The manifest or listing a build would publish holds a value that must not ship (${first.message}); nothing was published.`,
    { reason: 'MANIFEST_UNSAFE_VALUE', path: first.path, issueCount: issues.length },
  );
}
