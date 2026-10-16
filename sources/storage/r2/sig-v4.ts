import { createHash, createHmac } from 'node:crypto';

import { compareCodeUnits } from '../../catalog/ordering.ts';

/** The key pair a request is signed with; the secret never leaves this module's HMACs. */
export interface SigningCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Where and when a signature is valid: R2 uses region `auto` and service `s3`. */
export interface SigningScope {
  readonly region: string;
  readonly service: string;
  readonly now: Date;
}

export interface RequestToSign {
  readonly method: string;
  readonly url: URL;
  /** Headers to sign besides `host`, `x-amz-date` and `x-amz-content-sha256`. */
  readonly headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body; the server rejects a body that does not match it. */
  readonly payloadSha256: string;
}

export const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const RFC3986_EXTRA_RESERVED = /[!'()*]/g;

function hmac(key: string | Buffer, text: string): Buffer {
  return createHmac('sha256', key).update(text).digest();
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Percent-encodes everything except `A-Z a-z 0-9 - . _ ~`, as SigV4 requires. */
export function encodeRfc3986(text: string): string {
  return encodeURIComponent(text).replace(
    RFC3986_EXTRA_RESERVED,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** S3 signs the path with each segment encoded once and the slashes kept. */
function canonicalPath(url: URL): string {
  const segments = decodeURIComponent(url.pathname).split('/');
  return segments.map(encodeRfc3986).join('/') || '/';
}

function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams].map(([name, value]): [string, string] => [
    encodeRfc3986(name),
    encodeRfc3986(value),
  ]);
  const sorted = pairs.toSorted(
    ([leftName, leftValue], [rightName, rightValue]) =>
      compareCodeUnits(leftName, rightName) || compareCodeUnits(leftValue, rightValue),
  );
  return sorted.map(([name, value]) => `${name}=${value}`).join('&');
}

/** Lower-case names, values trimmed with inner runs of spaces collapsed, sorted by name. */
function canonicalHeaderEntries(headers: Readonly<Record<string, string>>): [string, string][] {
  const entries = Object.entries(headers).map(([name, value]): [string, string] => [
    name.toLowerCase(),
    value.trim().replaceAll(/ +/g, ' '),
  ]);
  return entries.toSorted(([left], [right]) => compareCodeUnits(left, right));
}

function signingKey(secretAccessKey: string, dateStamp: string, scope: SigningScope): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const serviceKey = hmac(hmac(dateKey, scope.region), scope.service);
  return hmac(serviceKey, 'aws4_request');
}

/** `20130524T000000Z`: the request time in the compact ISO 8601 form SigV4 uses. */
function amzDateOf(now: Date): string {
  return now.toISOString().replaceAll(/[:-]|\.\d{3}/g, '');
}

/** Everything the signature covers, in the canonical form SigV4 hashes. */
interface CanonicalForm {
  readonly amzDate: string;
  readonly dateStamp: string;
  readonly credentialScope: string;
  readonly signedHeaders: string;
  readonly addedHeaders: Readonly<Record<string, string>>;
  readonly canonicalRequest: string;
}

function canonicalFormOf(request: RequestToSign, scope: SigningScope): CanonicalForm {
  const amzDate = amzDateOf(scope.now);
  const dateStamp = amzDate.slice(0, 8);
  const addedHeaders = { 'x-amz-date': amzDate, 'x-amz-content-sha256': request.payloadSha256 };
  const headerEntries = canonicalHeaderEntries({
    ...request.headers,
    ...addedHeaders,
    host: request.url.host,
  });
  const signedHeaders = headerEntries.map(([name]) => name).join(';');
  const canonicalRequest = [
    request.method,
    canonicalPath(request.url),
    canonicalQuery(request.url),
    headerEntries.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders,
    request.payloadSha256,
  ].join('\n');
  const credentialScope = `${dateStamp}/${scope.region}/${scope.service}/aws4_request`;
  return { amzDate, dateStamp, credentialScope, signedHeaders, addedHeaders, canonicalRequest };
}

/** The canonical request text SigV4 hashes; exposed so tests can check it independently. */
export function canonicalRequestOf(request: RequestToSign, scope: SigningScope): string {
  return canonicalFormOf(request, scope).canonicalRequest;
}

function signatureOf(form: CanonicalForm, secretAccessKey: string, scope: SigningScope): string {
  const canonicalRequestHash = sha256Hex(form.canonicalRequest);
  const stringToSign = [ALGORITHM, form.amzDate, form.credentialScope, canonicalRequestHash].join(
    '\n',
  );
  return hmac(signingKey(secretAccessKey, form.dateStamp, scope), stringToSign).toString('hex');
}

/**
 * Signs a request with AWS Signature Version 4 and returns the headers to send: the given ones
 * plus `x-amz-date`, `x-amz-content-sha256` and `authorization`. `host` is signed but not
 * returned, because `fetch` sets it from the URL.
 */
export function signRequest(
  request: RequestToSign,
  credentials: SigningCredentials,
  scope: SigningScope,
): Record<string, string> {
  const form = canonicalFormOf(request, scope);
  const signature = signatureOf(form, credentials.secretAccessKey, scope);
  const credential = `Credential=${credentials.accessKeyId}/${form.credentialScope}`;
  const authorization = `${ALGORITHM} ${credential}, SignedHeaders=${form.signedHeaders}, Signature=${signature}`;
  return { ...request.headers, ...form.addedHeaders, authorization };
}
