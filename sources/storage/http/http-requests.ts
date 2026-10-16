import { PipelineError } from '../../errors.ts';
import { withIdleTimeout } from './idle-timeout.ts';
import { encodeRfc3986 } from '../r2/sig-v4.ts';
import { eitherSignal } from '../transfer/signals.ts';

const DECIMAL_DIGITS = /^\d+$/;

/**
 * Keys are sent as path segments, and URL parsing would drop `.` and `..` segments (also when
 * percent-encoded), silently reaching another object or even another bucket; such keys are
 * refused.
 */
function assertSendableKey(key: string): void {
  const segments = key.split('/');
  if (segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')) return;
  throw new PipelineError('INVALID_DATA', 'Object keys may not have empty, "." or ".." segments.', {
    key,
  });
}

/** The key as URL path segments, each percent-encoded once. */
export function encodedKeySegments(key: string): string[] {
  assertSendableKey(key);
  return key.split('/').map(encodeRfc3986);
}

interface HeaderDeadline {
  readonly signal: AbortSignal | undefined;
  readonly stop: () => void;
}

/**
 * Aborts with a TimeoutError unless stopped within `timeoutMs`. It is stopped once the response
 * headers arrive, so it bounds sending the request and waiting for the answer, never how long a
 * response body may take to download.
 */
function headerDeadline(timeoutMs: number | undefined): HeaderDeadline {
  if (timeoutMs === undefined) return { signal: undefined, stop: () => undefined };
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The request timed out.', 'TimeoutError'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    stop: () => {
      clearTimeout(timer);
    },
  };
}

/** One HTTP request; `timeoutMs` bounds the time until its response headers arrive. */
export interface HttpRequest {
  readonly url: URL;
  readonly init: Omit<RequestInit, 'signal' | 'redirect'>;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
}

/**
 * True for a 3xx answer. Redirects are never followed: a signed request must not be forwarded,
 * and a pinned object is read only from the configured address. Callers report them as a
 * configuration problem (the endpoint or base URL is not where the objects are).
 */
export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * Sends one request without following a redirect, so the caller sees the 3xx answer itself and
 * interprets every status.
 */
export async function fetchWithHeaderDeadline(request: HttpRequest): Promise<Response> {
  const deadline = headerDeadline(request.timeoutMs);
  try {
    return await fetch(request.url, {
      ...request.init,
      redirect: 'manual',
      signal: eitherSignal(request.signal, deadline.signal) ?? null,
    });
  } finally {
    deadline.stop();
  }
}

/** The response's declared body size; a missing or malformed one is never read as 0 bytes. */
export function contentLengthOf(response: Response, key: string): number {
  const header = response.headers.get('content-length') ?? '';
  const bytes = Number(header);
  if (DECIMAL_DIGITS.test(header) && Number.isSafeInteger(bytes)) return bytes;
  throw new PipelineError('INVALID_DATA', 'The server reported no valid object size.', { key });
}

/** Which object a download is for, how long its body may stall, and the run's signal. */
export interface DownloadLimits {
  readonly key: string;
  readonly idleTimeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

/**
 * Starts a download with `send`, which gets the signal to send with and resolves to a successful
 * response, and streams its body once, failing if it stalls for longer than `idleTimeoutMs`
 * between two chunks; a stall aborts the request.
 */
export async function openIdleLimitedBody(
  send: (signal: AbortSignal | undefined) => Promise<Response>,
  { key, idleTimeoutMs, signal }: DownloadLimits,
): Promise<AsyncIterable<Uint8Array>> {
  const stall = new AbortController();
  const response = await send(eitherSignal(stall.signal, signal));
  if (response.body === null) {
    throw new PipelineError('INVALID_DATA', 'The server returned no object body.', { key });
  }
  const stopTransfer = (): void => {
    stall.abort();
  };
  return withIdleTimeout(response.body, { timeoutMs: idleTimeoutMs, key, stopTransfer });
}
