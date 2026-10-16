import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';

import type { FakeS3Request, RequestFault, RequestPlan } from './fake-s3.test-support.ts';

// A fixed-seed fault matrix: each cell names one storage step and a kind of fault, and the seed
// picks its parameters (which request, which status, which byte). Every request a run sends is
// recorded with what was done to it, so a failing run prints a trace and the command to replay
// exactly that cell and seed.

/** Seeds every cell runs with unless the environment asks for others. */
const DEFAULT_SEEDS = [1, 2, 3];

/**
 * The seeds a matrix runs: `CRATEPIN_FAULT_SEED=<n>` replays one seed,
 * `CRATEPIN_FAULT_SWEEP=<count>` runs seeds 1 to count, otherwise the default seeds.
 */
export function faultSeeds(variables: NodeJS.ProcessEnv = process.env): number[] {
  const seed = Number(variables.CRATEPIN_FAULT_SEED);
  if (Number.isInteger(seed) && seed > 0) return [seed];
  const sweep = Number(variables.CRATEPIN_FAULT_SWEEP);
  if (Number.isInteger(sweep) && sweep > 0)
    return Array.from({ length: sweep }, (_, index) => index + 1);
  return DEFAULT_SEEDS;
}

/** A deterministic source of numbers in [0, 1) (mulberry32): one seed, one sequence. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One of `choices`, picked by `random`. */
function pickOne<Choice>(random: () => number, choices: readonly Choice[]): Choice {
  const choice = choices[Math.floor(random() * choices.length)];
  if (choice === undefined) throw new Error('nothing to pick from');
  return choice;
}

/** The step of a storage operation a request belongs to. */
export type StorageStep = 'head' | 'get' | 'put' | 'initiate' | 'part' | 'complete' | 'abort';

const STEPS_BY_QUERY: readonly [method: string, queryStart: string, step: StorageStep][] = [
  ['POST', 'uploads', 'initiate'],
  ['PUT', 'partNumber', 'part'],
  ['POST', 'uploadId', 'complete'],
  ['DELETE', 'uploadId', 'abort'],
];
const STEPS_BY_METHOD = new Map<string, StorageStep>([
  ['HEAD', 'head'],
  ['GET', 'get'],
  ['PUT', 'put'],
]);

export function stepOf({ method, query }: FakeS3Request): StorageStep {
  const byQuery = STEPS_BY_QUERY.find(
    ([stepMethod, queryStart]) => stepMethod === method && query.startsWith(queryStart),
  );
  const step = byQuery?.[2] ?? STEPS_BY_METHOD.get(method);
  if (step === undefined) throw new Error(`no storage step for ${method} ?${query}`);
  return step;
}

/** One fault a cell injects: into which request of a step, how often, and what it does. */
export interface FaultTarget {
  readonly step: StorageStep;
  /** Only requests for this key, e.g. the original that goes in parts. */
  readonly key?: string;
  /** Which matching request is hit first (1-based); the seed picks it when unset. */
  readonly nth?: number;
  /** When the seed picks: one of the first this many matching requests (3 by default). */
  readonly upTo?: number;
  /** How many matching requests in a row get the fault: 1 by default. */
  readonly times?: number;
  readonly fault: (random: () => number) => RequestFault;
}

/** What happened to one request: its order, step, short key, query and the decision. */
interface TraceLine {
  readonly order: number;
  readonly step: StorageStep;
  readonly key: string;
  readonly query: string;
  readonly decision: string;
}

/** The requests of one run and what the plan did to each, in arrival order. */
export class FaultTrace {
  readonly lines: TraceLine[] = [];

  record(request: FakeS3Request, fault: RequestFault | undefined): void {
    this.lines.push({
      order: this.lines.length + 1,
      step: stepOf(request),
      key: request.key.slice(-12),
      query: request.query.replace(/upload-\d+/gu, 'upload'),
      decision: describeFault(fault),
    });
  }

  /** Something the test did besides a planned fault, e.g. a cancel, in the order it happened. */
  note(request: FakeS3Request, action: string): void {
    this.lines.push({
      order: this.lines.length + 1,
      step: stepOf(request),
      key: request.key.slice(-12),
      query: '',
      decision: action,
    });
  }

  toString(): string {
    return this.lines
      .map(({ order, step, key, query, decision }) =>
        `${String(order).padStart(3)} ${step.padEnd(8)} …${key} ${query} -> ${decision}`.trimEnd(),
      )
      .join('\n');
  }
}

const FAULT_DESCRIPTIONS: readonly [
  (fault: RequestFault) => boolean,
  (fault: RequestFault) => string,
][] = [
  [
    (fault) => fault.refuse !== undefined,
    (fault) => `refuse ${String(fault.refuse?.status)} ${String(fault.refuse?.s3Code)}`,
  ],
  [(fault) => fault.losesAnswer === true, () => 'act, lose answer'],
  [
    (fault) => fault.dropAfterBytes !== undefined,
    (fault) => `drop after ${String(fault.dropAfterBytes)} bytes`,
  ],
  [(fault) => fault.midBody !== undefined, () => 'act mid-body'],
  [(fault) => fault.headers !== undefined, () => 'change body under plausible headers'],
];

function describeFault(fault: RequestFault | undefined): string {
  if (fault === undefined) return 'pass';
  const described = FAULT_DESCRIPTIONS.find(([applies]) => applies(fault));
  return described === undefined ? 'change body' : described[1](fault);
}

/** Counts matching requests per target and decides whether the current one is hit. */
class TargetCounter {
  private seen = 0;
  private readonly target: FaultTarget;
  private readonly first: number;
  private readonly fault: RequestFault;

  constructor(target: FaultTarget, random: () => number) {
    this.target = target;
    this.first = target.nth ?? 1 + Math.floor(random() * (target.upTo ?? 3));
    this.fault = target.fault(random);
  }

  private matches(request: FakeS3Request): boolean {
    const isForKey = this.target.key === undefined || request.key === this.target.key;
    return isForKey && stepOf(request) === this.target.step;
  }

  faultFor(request: FakeS3Request): RequestFault | undefined {
    if (!this.matches(request)) return undefined;
    this.seen += 1;
    const isHit = this.seen >= this.first && this.seen < this.first + (this.target.times ?? 1);
    return isHit ? this.fault : undefined;
  }
}

/** A request plan injecting `targets` with parameters `seed` picks, recording every request in `trace`. */
export function faultPlanOf(
  targets: readonly FaultTarget[],
  { seed, trace }: { readonly seed: number; readonly trace: FaultTrace },
): RequestPlan {
  const random = seededRandom(seed);
  const counters = targets.map((target) => new TargetCounter(target, random));
  return (request) => {
    const fault = counters.map((counter) => counter.faultFor(request)).find(Boolean);
    trace.record(request, fault);
    return fault;
  };
}

/** The command that runs exactly one cell with one seed again. */
export function replayCommand(cellId: string, seed: number, file: string): string {
  return `CRATEPIN_FAULT_SEED=${String(seed)} node --test --test-name-pattern="${cellId} seed ${String(seed)}$" ${file}`;
}

/** Runs `check`; if it fails, prints the trace and the replay command first. */
export async function withTraceOnFailure(
  context: TestContext,
  { trace, replay }: { readonly trace: FaultTrace; readonly replay: string },
  check: () => Promise<void>,
): Promise<void> {
  try {
    await check();
  } catch (error) {
    context.diagnostic(`replay: ${replay}`);
    context.diagnostic(`trace:\n${trace.toString()}`);
    throw error;
  }
}

/** Transient answers storage gives under load; the client retries them. */
const TRANSIENT_REFUSALS = [
  { status: 500, s3Code: 'InternalError' },
  { status: 503, s3Code: 'SlowDown' },
  { status: 429, s3Code: 'TooManyRequests' },
] as const;

/** Answers no retry can change. */
const PERMANENT_REFUSALS = [
  { status: 403, s3Code: 'AccessDenied' },
  { status: 400, s3Code: 'InvalidRequest' },
] as const;

export function transientRefusal(random: () => number): RequestFault {
  return { refuse: pickOne(random, TRANSIENT_REFUSALS) };
}

export function permanentRefusal(random: () => number): RequestFault {
  return { refuse: pickOne(random, PERMANENT_REFUSALS) };
}

/** A body of the stored length with one byte the seed picks flipped. */
export function flippedByte(random: () => number): RequestFault {
  const position = random();
  return {
    body: (content) => {
      const changed = Buffer.from(content);
      const index = Math.floor(position * changed.length);
      changed[index] = (changed[index] ?? 0) ^ 0x5a;
      return changed;
    },
  };
}

/**
 * A flipped byte under answer headers that look right: the MD5 ETag R2 gives the stored bytes,
 * their SHA-256 as `x-amz-meta-sha256` and their length. Only hashing the body tells.
 */
export function wrongBytesUnderPlausibleHeaders(random: () => number): RequestFault {
  return {
    ...flippedByte(random),
    headers: (stored) => ({
      // eslint-disable-next-line sonarjs/hashing -- R2's ETag of a single PUT; never trusted
      etag: `"${createHash('md5').update(stored).digest('hex')}"`,
      'x-amz-meta-sha256': createHash('sha256').update(stored).digest('hex'),
    }),
  };
}

/** A connection closed after the answer's headers, before any body byte: a read may retry it. */
export function droppedBeforeBody(): RequestFault {
  return { dropAfterBytes: 0 };
}

/** A connection closed after the first 1 to 3 body bytes the seed picks. */
export function droppedMidBody(random: () => number): RequestFault {
  return { dropAfterBytes: 1 + Math.floor(random() * 3) };
}

/** A body with bytes appended: storage claims a longer object. */
export function extendedBody(random: () => number): RequestFault {
  const extra = Buffer.alloc(1 + Math.floor(random() * 16), 0x21);
  return { body: (content) => Buffer.concat([content, extra]) };
}

/** A body that ends cleanly but short: storage claims a shorter object. */
export function shortenedBody(random: () => number): RequestFault {
  const missing = 1 + Math.floor(random() * 3);
  return { body: (content) => content.subarray(0, Math.max(0, content.length - missing)) };
}
