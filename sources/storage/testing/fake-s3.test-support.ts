import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import type { R2Connection } from '../r2/r2-connection.ts';
import { signRequest } from '../r2/sig-v4.ts';

export const FAKE_CREDENTIALS = {
  accessKeyId: 'fake-access-key-id-0001',
  secretAccessKey: 'fake-secret-access-key-0001',
};
/** A key scoped to reading the bucket, as CI gets: storage refuses its writes as AccessDenied. */
export const FAKE_READ_ONLY_CREDENTIALS = {
  accessKeyId: 'fake-read-only-key-id-0002',
  secretAccessKey: 'fake-read-only-secret-0002',
};
const CREDENTIALS_BY_KEY_ID = new Map(
  [FAKE_CREDENTIALS, FAKE_READ_ONLY_CREDENTIALS].map((pair) => [pair.accessKeyId, pair]),
);
const FAKE_BUCKET = 'fake-bucket';
/** The first path segment of anonymous reads, like a public bucket URL. */
const PUBLIC_PATH = 'public';
/** What anonymous public access and the read-only key may do. */
const READ_METHODS = new Set(['GET', 'HEAD']);
const COMPLETION_RESULT =
  '<CompleteMultipartUploadResult><ETag>"multi"</ETag></CompleteMultipartUploadResult>';
const AUTOMATICALLY_SIGNED = new Set(['host', 'x-amz-date', 'x-amz-content-sha256']);
/** What a client sees when storage acted but its answer was lost on the way. */
const LOST_ANSWER = { status: 500, s3Code: 'InternalError' };

/** A scripted failure: the next `times` (default 1) matching requests get this status. */
export interface FakeS3Fault {
  readonly method: string;
  readonly key?: string;
  /** Only requests whose query string contains this text, e.g. `partNumber=2`. */
  readonly queryIncludes?: string;
  readonly status: number;
  readonly s3Code: string;
  readonly times?: number;
  /** Sent as the Location header, e.g. to answer with a redirect. */
  readonly location?: string;
  /** Filler before the error code, to test how much of an error body a client reads. */
  readonly paddingBytes?: number;
}

/**
 * What a request plan (`planRequests`) does to one request. Unlike `failNext`, it can act after
 * storage did: keep the bytes and lose the answer, or change what a GET sends.
 */
export interface RequestFault {
  /** Overrides a control/error body or leaves it open after sending its headers and bytes. */
  readonly controlBody?: ControlBodyFault;
  /** Refused before storage acts, like a scripted fault. */
  readonly refuse?: { readonly status: number; readonly s3Code: string };
  /**
   * Storage acts (stores, completes, starts or aborts an upload), then the answer is lost: the
   * client sees a 500.
   */
  readonly losesAnswer?: boolean;
  /** For a GET: the body sent instead of the stored bytes; its length is declared. */
  readonly body?: (content: Buffer) => Buffer;
  /** For a GET: the connection closes after this many body bytes, short of the declared length. */
  readonly dropAfterBytes?: number;
  /**
   * For a GET: runs once the first half of the body is sent; the rest follows once what it returns
   * settles, so a test can hold a download half done.
   */
  readonly midBody?: () => unknown;
  /** For a GET or HEAD: headers sent with the answer, made from the stored bytes. */
  readonly headers?: (stored: Buffer) => Record<string, string>;
}

interface ControlBodyFault {
  readonly bytes?: Uint8Array;
  readonly isStalled?: boolean;
  /** Independent watchdog: a broken client budget must fail its test rather than hang it. */
  readonly releaseAfterMs?: number;
}

interface ControlAnswer {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly text?: string;
}

function controlBytesOf(answer: ControlAnswer, fault: ControlBodyFault | undefined) {
  return fault?.bytes ?? answer.text ?? '';
}

function releaseControlLater(response: ServerResponse, timeoutMs: number | undefined): void {
  if (timeoutMs === undefined) return;
  const timer = setTimeout(() => {
    response.end();
  }, timeoutMs);
  response.once('close', () => {
    clearTimeout(timer);
  });
}

function sendControl(
  response: ServerResponse,
  answer: ControlAnswer,
  fault?: ControlBodyFault,
): void {
  response.writeHead(answer.status, answer.headers ?? {});
  const body = controlBytesOf(answer, fault);
  if (fault?.isStalled === true) {
    response.write(body);
    response.flushHeaders();
    releaseControlLater(response, fault.releaseAfterMs);
    return;
  }
  response.end(body);
}

function sendEmptySuccess(exchange: Exchange, headers: Readonly<Record<string, string>>): void {
  sendControl(exchange.response, { status: 200, headers }, exchange.fault?.controlBody);
}

/** Decides, for each request as it arrives, whether and how it fails. */
export type RequestPlan = (request: FakeS3Request) => RequestFault | undefined;

/** Unusual server behaviour a test can switch on. */
export interface FakeConditions {
  /** Delays every answer, e.g. to trigger a client timeout. */
  readonly responseDelayMs?: number;
  /** Delays answers to requests whose query string contains `queryIncludes`. */
  readonly slowQuery?: { readonly queryIncludes: string; readonly delayMs: number };
  /** How GET bodies are sent; all at once when unset. */
  readonly getBodyPacing?: BodyPacing;
  /** Answers completions with 200 and an error document instead of completing, as S3 can. */
  readonly omitsCompletionResult?: boolean;
  /** The ETag of each uploaded part; real ETags are quoted and may hold XML characters. */
  readonly partEtagOf?: (content: Buffer) => string;
}

/** How a GET body is sent: in chunks with pauses, optionally stalling or cut off. */
interface BodyPacing {
  readonly chunkBytes: number;
  readonly pauseMs: number;
  readonly stallAfterBytes?: number;
  /** Closes the connection after this many bytes, short of the declared length. */
  readonly dropAfterBytes?: number;
}

export interface FakeS3Request {
  readonly method: string;
  readonly key: string;
  readonly query: string;
  /** Whether the request carried an Authorization header at all. */
  readonly isSigned: boolean;
  /** The access key ID the request names in its Authorization header, if signed. */
  readonly accessKeyId?: string;
  /** The `If-None-Match` header, `*` on a create-only write. */
  readonly ifNoneMatch?: string;
}

/** One request with the parts every handler needs. */
interface Exchange {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly method: string;
  readonly key: string;
  readonly query: URLSearchParams;
  /** What the request plan decided for this request, if anything. */
  readonly fault?: RequestFault;
}

interface Route {
  readonly method: string;
  readonly queryKey?: string;
  readonly run: (exchange: Exchange) => Promise<void>;
}

interface MultipartUpload {
  readonly key: string;
  readonly parts: Map<number, { readonly content: Buffer; readonly etag: string }>;
}

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

interface FakeError {
  readonly status: number;
  readonly s3Code: string;
  readonly paddingBytes?: number;
}

function sendError(
  response: ServerResponse,
  { status, s3Code, paddingBytes = 0 }: FakeError,
  fault?: ControlBodyFault,
): void {
  const padding = `<!--${' '.repeat(paddingBytes)}-->`;
  sendControl(
    response,
    {
      status,
      headers: { 'content-type': 'application/xml' },
      text: `<?xml version="1.0"?><Error>${padding}<Code>${s3Code}</Code><Message>fake</Message></Error>`,
    },
    fault,
  );
}

/** How much of `content` a paced body sends before it ends, stalls or is cut off. */
function pacedLengthOf(content: Buffer, pacing: BodyPacing): number {
  return Math.min(
    content.length,
    pacing.stallAfterBytes ?? pacing.dropAfterBytes ?? content.length,
  );
}

/** Sends `content` in paced chunks; never ends when it stalls, until the client gives up. */
async function sendPaced(
  response: ServerResponse,
  content: Buffer,
  pacing: BodyPacing,
): Promise<void> {
  const sentBytes = pacedLengthOf(content, pacing);
  for (let offset = 0; offset < sentBytes && !response.destroyed; offset += pacing.chunkBytes) {
    response.write(content.subarray(offset, Math.min(offset + pacing.chunkBytes, sentBytes)));
    await delay(pacing.pauseMs);
  }
  if (pacing.dropAfterBytes !== undefined) response.destroy();
  else if (pacing.stallAfterBytes === undefined) response.end();
}

/**
 * Sends the first half of `content`, runs `between` once it is on the way and waits for what it
 * returns, then sends the rest.
 */
async function sendInHalves(
  response: ServerResponse,
  content: Buffer,
  between: () => unknown,
): Promise<void> {
  const half = Math.floor(content.length / 2);
  await new Promise<void>((resolve) => {
    response.write(content.subarray(0, half), () => {
      resolve();
    });
  });
  await between();
  await delay(5);
  if (!response.destroyed) response.end(content.subarray(half));
}

function sendXml(exchange: Exchange, xml: string): void {
  sendControl(
    exchange.response,
    { status: 200, headers: { 'content-type': 'application/xml' }, text: xml },
    exchange.fault?.controlBody,
  );
}

function headerText(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(',') : (value ?? '');
}

/** `20130524T000000Z` back to a Date. */
function requestTime(request: IncomingMessage): Date {
  const amzDate = headerText(request, 'x-amz-date');
  const iso = amzDate.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    '$1-$2-$3T$4:$5:$6Z',
  );
  return new Date(iso);
}

function signedHeaderValues(request: IncomingMessage): Record<string, string> {
  const authorization = headerText(request, 'authorization');
  const names = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(';') ?? [];
  const extra = names.filter((name) => !AUTOMATICALLY_SIGNED.has(name));
  return Object.fromEntries(extra.map((name) => [name, headerText(request, name)]));
}

function ifNoneMatchOf(request: IncomingMessage): { ifNoneMatch?: string } {
  const value = headerText(request, 'if-none-match');
  return value === '' ? {} : { ifNoneMatch: value };
}

/** The access key ID a signed request names (`Credential=<id>/...`). */
function accessKeyIdOf(request: IncomingMessage): string | undefined {
  return /Credential=([^/,]+)\//.exec(headerText(request, 'authorization'))?.[1];
}

/** Recomputes the SigV4 authorization from the request exactly as received, for a known key. */
function isCorrectlySigned(request: IncomingMessage): boolean {
  const credentials = CREDENTIALS_BY_KEY_ID.get(accessKeyIdOf(request) ?? '');
  if (credentials === undefined) return false;
  const expected = signRequest(
    {
      method: request.method ?? '',
      url: new URL(`http://${headerText(request, 'host')}${request.url ?? ''}`),
      headers: signedHeaderValues(request),
      payloadSha256: headerText(request, 'x-amz-content-sha256'),
    },
    credentials,
    { region: 'auto', service: 's3', now: requestTime(request) },
  );
  return expected.authorization === headerText(request, 'authorization');
}

function isWriteWithReadOnlyKey({ request, method }: Exchange): boolean {
  const isReadOnlyKey = accessKeyIdOf(request) === FAKE_READ_ONLY_CREDENTIALS.accessKeyId;
  return isReadOnlyKey && !READ_METHODS.has(method);
}

/** The whole body, or `undefined` when the client aborted while sending it. */
async function bodyOf(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  } catch {
    return undefined;
  }
}

/**
 * The body if it came with a Content-Length (S3 refuses chunked uploads) and its SHA-256 matches
 * the signed payload hash; otherwise answers and returns nothing.
 */
async function verifiedBody(exchange: Exchange): Promise<Buffer | undefined> {
  const hasLength = headerText(exchange.request, 'content-length') !== '';
  const body = await bodyOf(exchange.request);
  if (!hasLength) {
    sendError(exchange.response, { status: 411, s3Code: 'MissingContentLength' });
    return undefined;
  }
  if (body === undefined) return undefined;
  const declared = headerText(exchange.request, 'x-amz-content-sha256');
  if (declared === sha256Hex(body)) return body;
  sendError(exchange.response, { status: 400, s3Code: 'XAmzContentSHA256Mismatch' });
  return undefined;
}

function defaultPartEtag(content: Buffer): string {
  return `"${sha256Hex(content).slice(0, 32)}"`;
}

function unescapeXml(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/** Part number and ETag of every `<Part>` of a completion request. */
function listedPartsOf(
  completionXml: string,
): { readonly number: number; readonly etag: string }[] {
  const parts = completionXml.matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag>/g);
  return [...parts].map(([, number = '', etag = '']) => ({
    number: Number(number),
    etag: unescapeXml(etag),
  }));
}

/** A local, in-memory S3 subset that checks SigV4 signatures and payload hashes like R2 does. */
export class FakeS3 {
  readonly objects = new Map<string, Buffer>();
  readonly requests: FakeS3Request[] = [];
  readonly uploads = new Map<string, MultipartUpload>();
  /** Upload IDs of completed uploads, which an abort still answers with 204, as R2 does. */
  private readonly completedUploadIds = new Set<string>();
  private requestPlan: RequestPlan | undefined;
  /** Upload IDs are numbered, so a test run names the same IDs each time. */
  private uploadCount = 0;
  /** Keys whose HEAD answer leaves out Content-Length. */
  readonly objectsWithoutReportedSize = new Set<string>();
  /** The most part uploads that were in progress at the same time. */
  maxConcurrentParts = 0;
  /** The most requests of each method that were in progress at the same time. */
  readonly maxConcurrentByMethod = new Map<string, number>();
  private activeParts = 0;
  private readonly activeByMethod = new Map<string, number>();
  private conditions: FakeConditions = {};
  private readonly faults: { fault: FakeS3Fault; remaining: number }[] = [];
  private readonly beforeStore = new Map<string, () => void>();
  private readonly server: Server;

  private constructor() {
    this.server = createServer((request, response) => {
      void this.respond(request, response);
    });
  }

  /** Starts the fake on a free loopback port. */
  static async start(): Promise<FakeS3> {
    const fake = new FakeS3();
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  get connection(): R2Connection {
    const { port } = this.server.address() as AddressInfo;
    return {
      endpoint: new URL(`http://127.0.0.1:${String(port)}/`),
      bucket: FAKE_BUCKET,
      credentials: FAKE_CREDENTIALS,
    };
  }

  /** The same bucket reached with the read-only key. */
  get readOnlyConnection(): R2Connection {
    return { ...this.connection, credentials: FAKE_READ_ONLY_CREDENTIALS };
  }

  /** Where objects can be read without signing, like a public bucket's URL. */
  get publicBaseUrl(): URL {
    return new URL(`${this.connection.endpoint.href}${PUBLIC_PATH}`);
  }

  /** Switches on unusual behaviour for the rest of the test. */
  simulate(conditions: FakeConditions): void {
    this.conditions = { ...this.conditions, ...conditions };
  }

  failNext(fault: FakeS3Fault): void {
    this.faults.push({ fault, remaining: fault.times ?? 1 });
  }

  /** Lets `plan` decide the fault of every request from now on; `undefined` ends the plan. */
  planRequests(plan: RequestPlan | undefined): void {
    this.requestPlan = plan;
  }

  /** Runs right before the next upload of `key` is stored, e.g. to simulate a concurrent writer. */
  beforeNextStore(key: string, action: () => void): void {
    this.beforeStore.set(key, action);
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const arrived = this.exchangeOf(request, response);
    const accessKeyId = accessKeyIdOf(request);
    const record: FakeS3Request = {
      method: arrived.method,
      key: arrived.key,
      query: arrived.query.toString(),
      isSigned: headerText(request, 'authorization') !== '',
      ...(accessKeyId === undefined ? {} : { accessKeyId }),
      ...ifNoneMatchOf(request),
    };
    this.requests.push(record);
    const fault = this.requestPlan?.(record);
    const exchange = fault === undefined ? arrived : { ...arrived, fault };
    this.countActive(exchange.method, 1);
    try {
      await this.answer(exchange, request, response);
    } finally {
      this.countActive(exchange.method, -1);
    }
  }

  private async answer(
    exchange: Exchange,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    await delay(this.delayFor(exchange));
    const refusal: Omit<FakeS3Fault, 'method'> | undefined =
      this.refusalOf(exchange) ?? exchange.fault?.refuse;
    if (refusal === undefined) {
      await this.dispatch(exchange);
      return;
    }
    await bodyOf(request);
    if (refusal.location !== undefined) response.setHeader('location', refusal.location);
    sendError(response, refusal, exchange.fault?.controlBody);
  }

  private countActive(method: string, change: number): void {
    const active = (this.activeByMethod.get(method) ?? 0) + change;
    this.activeByMethod.set(method, active);
    this.maxConcurrentByMethod.set(
      method,
      Math.max(this.maxConcurrentByMethod.get(method) ?? 0, active),
    );
  }

  private delayFor(exchange: Exchange): number {
    const { responseDelayMs = 0, slowQuery } = this.conditions;
    const isSlow =
      slowQuery !== undefined && exchange.query.toString().includes(slowQuery.queryIncludes);
    return isSlow ? responseDelayMs + slowQuery.delayMs : responseDelayMs;
  }

  private exchangeOf(request: IncomingMessage, response: ServerResponse): Exchange {
    const url = new URL(`http://fake${request.url ?? ''}`);
    const [, , ...keySegments] = url.pathname.split('/');
    const key = keySegments.map(decodeURIComponent).join('/');
    return { request, response, method: request.method ?? '', key, query: url.searchParams };
  }

  /**
   * A bad signature, an unknown bucket, a write with the read-only key or a scripted fault, in that
   * order. Anonymous reads under the public path need no signature but may only read.
   */
  private refusalOf(exchange: Exchange): Omit<FakeS3Fault, 'method'> | undefined {
    const bucket = decodeURIComponent(
      new URL(`http://fake${exchange.request.url ?? ''}`).pathname.split('/')[1] ?? '',
    );
    if (bucket === PUBLIC_PATH) return this.anonymousRefusalOf(exchange);
    return this.signedRefusalOf(exchange, bucket);
  }

  private signedRefusalOf(
    exchange: Exchange,
    bucket: string,
  ): Omit<FakeS3Fault, 'method'> | undefined {
    if (!isCorrectlySigned(exchange.request))
      return { status: 403, s3Code: 'SignatureDoesNotMatch' };
    if (bucket !== FAKE_BUCKET) return { status: 404, s3Code: 'NoSuchBucket' };
    if (isWriteWithReadOnlyKey(exchange)) return { status: 403, s3Code: 'AccessDenied' };
    return this.takeDueFault(exchange);
  }

  private anonymousRefusalOf(exchange: Exchange): Omit<FakeS3Fault, 'method'> | undefined {
    if (!READ_METHODS.has(exchange.method)) return { status: 403, s3Code: 'AccessDenied' };
    return this.takeDueFault(exchange);
  }

  private takeDueFault(exchange: Exchange): FakeS3Fault | undefined {
    const query = exchange.query.toString();
    const pending = this.faults.find(
      ({ fault, remaining }) =>
        remaining > 0 &&
        fault.method === exchange.method &&
        (fault.key === undefined || fault.key === exchange.key) &&
        query.includes(fault.queryIncludes ?? ''),
    );
    if (pending) pending.remaining -= 1;
    return pending?.fault;
  }

  /** Query-specific routes first: a multipart part is also a PUT. */
  private readonly routes: readonly Route[] = [
    { method: 'POST', queryKey: 'uploads', run: (exchange) => this.createMultipart(exchange) },
    { method: 'PUT', queryKey: 'uploadId', run: (exchange) => this.uploadPart(exchange) },
    { method: 'POST', queryKey: 'uploadId', run: (exchange) => this.completeMultipart(exchange) },
    { method: 'DELETE', queryKey: 'uploadId', run: (exchange) => this.abortMultipart(exchange) },
    { method: 'PUT', run: (exchange) => this.putObject(exchange) },
    { method: 'GET', run: (exchange) => this.headOrGet(exchange) },
    { method: 'HEAD', run: (exchange) => this.headOrGet(exchange) },
  ];

  private dispatch(exchange: Exchange): Promise<void> {
    const route = this.routes.find(
      ({ method, queryKey }) =>
        method === exchange.method && (queryKey === undefined || exchange.query.has(queryKey)),
    );
    if (route !== undefined) return route.run(exchange);
    sendError(exchange.response, { status: 405, s3Code: 'MethodNotAllowed' });
    return Promise.resolve();
  }

  /** The bytes a read of `key` gets: the stored ones, or what the plan's body fault makes of them. */
  private servedContentOf(key: string, fault: RequestFault | undefined): Buffer | undefined {
    const stored = this.objects.get(key);
    return stored === undefined || fault?.body === undefined ? stored : fault.body(stored);
  }

  /** Size (unless withheld), the fake's ETag, and any headers the plan's fault adds. */
  private answerHeadersOf(
    key: string,
    content: Buffer,
    fault: RequestFault | undefined,
  ): Record<string, string> {
    const size = this.objectsWithoutReportedSize.has(key)
      ? {}
      : { 'content-length': String(content.length) };
    const extra = fault?.headers?.(this.objects.get(key) ?? content) ?? {};
    return { ...size, etag: '"not-a-sha256"', ...extra };
  }

  private headOrGet({ request, response, key, fault }: Exchange): Promise<void> {
    const content = this.servedContentOf(key, fault);
    if (content === undefined) {
      if (request.method === 'HEAD') response.writeHead(404).end();
      else sendError(response, { status: 404, s3Code: 'NoSuchKey' });
      return Promise.resolve();
    }
    response.writeHead(200, this.answerHeadersOf(key, content, fault));
    if (request.method !== 'HEAD') return this.sendBody(response, content, fault);
    response.end();
    return Promise.resolve();
  }

  private sendBody(response: ServerResponse, content: Buffer, fault?: RequestFault): Promise<void> {
    const dropAfterBytes = fault?.dropAfterBytes;
    const pacing =
      dropAfterBytes === undefined
        ? this.conditions.getBodyPacing
        : { chunkBytes: 1024, pauseMs: 0, dropAfterBytes };
    if (pacing !== undefined) return sendPaced(response, content, pacing);
    if (fault?.midBody !== undefined) return sendInHalves(response, content, fault.midBody);
    response.end(content);
    return Promise.resolve();
  }

  /**
   * Stores unless `If-None-Match: *` finds the key taken (answering 412 then); the hook runs
   * before that check. Returns whether the content was stored.
   */
  private store(exchange: Exchange, content: Buffer): boolean {
    this.beforeStore.get(exchange.key)?.();
    this.beforeStore.delete(exchange.key);
    const isCreateOnly = headerText(exchange.request, 'if-none-match') === '*';
    if (isCreateOnly && this.objects.has(exchange.key)) {
      sendError(
        exchange.response,
        { status: 412, s3Code: 'PreconditionFailed' },
        exchange.fault?.controlBody,
      );
      return false;
    }
    this.objects.set(exchange.key, content);
    return true;
  }

  private async putObject(exchange: Exchange): Promise<void> {
    const body = await verifiedBody(exchange);
    if (body === undefined || !this.store(exchange, body)) return;
    if (!this.answerLost(exchange)) {
      sendEmptySuccess(exchange, { etag: '"not-a-sha256"' });
    }
  }

  /** After storage acted: when the plan loses this answer, the client gets a 500 instead. */
  private answerLost(exchange: Exchange): boolean {
    if (exchange.fault?.losesAnswer !== true) return false;
    sendError(exchange.response, LOST_ANSWER);
    return true;
  }

  private async createMultipart(exchange: Exchange): Promise<void> {
    await bodyOf(exchange.request);
    this.uploadCount += 1;
    const uploadId = `upload-${String(this.uploadCount)}`;
    this.uploads.set(uploadId, { key: exchange.key, parts: new Map() });
    if (this.answerLost(exchange)) return;
    sendXml(
      exchange,
      `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
    );
  }

  private async uploadPart(exchange: Exchange): Promise<void> {
    this.activeParts += 1;
    this.maxConcurrentParts = Math.max(this.maxConcurrentParts, this.activeParts);
    try {
      await this.storePart(exchange);
    } finally {
      this.activeParts -= 1;
    }
  }

  private async storePart(exchange: Exchange): Promise<void> {
    const upload = this.uploads.get(exchange.query.get('uploadId') ?? '');
    const body = await verifiedBody(exchange);
    if (body === undefined) return;
    if (upload === undefined) {
      sendError(exchange.response, { status: 404, s3Code: 'NoSuchUpload' });
      return;
    }
    const etag = (this.conditions.partEtagOf ?? defaultPartEtag)(body);
    upload.parts.set(Number(exchange.query.get('partNumber')), { content: body, etag });
    if (!this.answerLost(exchange)) {
      sendEmptySuccess(exchange, { etag });
    }
  }

  /** The concatenated parts the completion lists, or `undefined` if one is unknown or its ETag differs. */
  private completedContent(uploadId: string, completion: string): Buffer | undefined {
    const upload = this.uploads.get(uploadId);
    const parts = listedPartsOf(completion).map(({ number, etag }) => {
      const stored = upload?.parts.get(number);
      return stored?.etag === etag ? stored.content : undefined;
    });
    if (upload === undefined || parts.some((part) => part === undefined)) return undefined;
    return Buffer.concat(parts.filter((part) => part !== undefined));
  }

  private async completeMultipart(exchange: Exchange): Promise<void> {
    const uploadId = exchange.query.get('uploadId') ?? '';
    const completion = (await verifiedBody(exchange))?.toString('utf8');
    if (completion !== undefined) this.complete(exchange, uploadId, completion);
  }

  private complete(exchange: Exchange, uploadId: string, completion: string): void {
    const content = this.completedContent(uploadId, completion);
    if (content === undefined) {
      sendError(exchange.response, { status: 400, s3Code: 'InvalidPart' });
      return;
    }
    if (this.conditions.omitsCompletionResult === true) {
      sendXml(exchange, '<Error><Code>InternalError</Code></Error>');
      return;
    }
    // A refused conditional completion leaves the upload open, as R2 does.
    if (!this.store(exchange, content)) return;
    this.uploads.delete(uploadId);
    this.completedUploadIds.add(uploadId);
    if (!this.answerLost(exchange)) sendXml(exchange, COMPLETION_RESULT);
  }

  /** As R2 answers: 204 for an open or completed upload, 404 NoSuchUpload for an unknown ID. */
  private async abortMultipart(exchange: Exchange): Promise<void> {
    await bodyOf(exchange.request);
    const uploadId = exchange.query.get('uploadId') ?? '';
    const isKnown = this.uploads.delete(uploadId) || this.completedUploadIds.has(uploadId);
    if (isKnown && this.answerLost(exchange)) return;
    if (isKnown) exchange.response.writeHead(204).end();
    else sendError(exchange.response, { status: 404, s3Code: 'NoSuchUpload' });
  }
}
