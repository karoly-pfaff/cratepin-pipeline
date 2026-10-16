import { PipelineError } from '../../errors.ts';
import { withIdleTimeout } from './idle-timeout.ts';

/** The request's body-idle budget and object, without any signing information. */
export interface ResponseLimits {
  readonly key: string | undefined;
  readonly timeoutMs: number;
}

interface BodyPolicy {
  readonly maxBytes: number;
  readonly isPrefix: boolean;
  readonly isTextRetained: boolean;
}

const XML_POLICY: BodyPolicy = { maxBytes: 65_536, isPrefix: false, isTextRetained: true };
const ERROR_POLICY: BodyPolicy = { maxBytes: 16_384, isPrefix: true, isTextRetained: true };
const DISCARD_POLICY: BodyPolicy = { maxBytes: 16_384, isPrefix: false, isTextRetained: false };

function ignoreCancellation(): void {
  // Closing an already failed response must not replace the original failure.
}

function oversizedBody(key: string | undefined, maxResponseBytes: number): PipelineError {
  return new PipelineError('INVALID_DATA', 'The server returned an oversized control response.', {
    maxResponseBytes,
    ...(key === undefined ? {} : { key }),
  });
}

/** Keeps only bounded text, or discards chunks without retaining them. */
class ResponseCollector {
  private readonly limits: ResponseLimits;
  private readonly policy: BodyPolicy;
  private readonly chunks: Buffer[] = [];
  private receivedBytes = 0;

  constructor(limits: ResponseLimits, policy: BodyPolicy) {
    this.limits = limits;
    this.policy = policy;
  }

  accept(chunk: Uint8Array): boolean {
    const remaining = this.policy.maxBytes - this.receivedBytes;
    this.receivedBytes += chunk.length;
    if (this.policy.isTextRetained) this.chunks.push(Buffer.from(chunk.subarray(0, remaining)));
    if (this.receivedBytes > this.policy.maxBytes && !this.policy.isPrefix) {
      throw oversizedBody(this.limits.key, this.policy.maxBytes);
    }
    return !this.policy.isPrefix || this.receivedBytes < this.policy.maxBytes;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

async function* chunksOf(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  try {
    let step = await reader.read();
    while (!step.done) {
      yield step.value;
      step = await reader.read();
    }
  } finally {
    await reader.cancel().catch(ignoreCancellation);
    reader.releaseLock();
  }
}

/** Cancelling through the owned reader also settles a read waiting for the next chunk. */
function timedChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limits: ResponseLimits,
): AsyncGenerator<Uint8Array> {
  return withIdleTimeout(chunksOf(reader), {
    timeoutMs: limits.timeoutMs,
    key: limits.key ?? '',
    stopTransfer: () => {
      void reader.cancel().catch(ignoreCancellation);
    },
  });
}

async function readResponse(
  response: Response,
  limits: ResponseLimits,
  policy: BodyPolicy,
): Promise<string> {
  if (response.body === null) return '';
  const collector = new ResponseCollector(limits, policy);
  for await (const chunk of timedChunks(response.body.getReader(), limits)) {
    if (!collector.accept(chunk)) break;
  }
  return collector.text();
}

/** Reads a complete control XML document, at most 64 KiB, with the request's body-idle budget. */
export function readControlText(response: Response, limits: ResponseLimits): Promise<string> {
  return readResponse(response, limits, XML_POLICY);
}

/** Only the first 16 KiB can supply an S3 code; an early stop cancels the remaining body. */
export function readErrorPrefix(response: Response, limits: ResponseLimits): Promise<string> {
  return readResponse(response, limits, ERROR_POLICY);
}

/** Drains at most 16 KiB with the same idle budget, retaining none of the unused body. */
export async function discardControlBody(
  response: Response,
  limits: ResponseLimits,
): Promise<void> {
  await readResponse(response, limits, DISCARD_POLICY);
}
