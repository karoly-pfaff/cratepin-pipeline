import { childPath } from '../config/rules/field-rules.ts';

interface ObjectFrame {
  readonly kind: 'object';
  readonly path: string;
  readonly keys: Set<string>;
  expectsKey: boolean;
  lastKey: string;
}

interface ArrayFrame {
  readonly kind: 'array';
  readonly path: string;
  index: number;
}

type ContainerFrame = ObjectFrame | ArrayFrame;

/**
 * Walks the structure of text that `JSON.parse` already accepted and records every object key
 * that appears twice. Only strings and the punctuation `{ } [ ] ,` matter; values are skipped.
 */
class DuplicateKeyScanner {
  readonly duplicatePaths: string[] = [];
  private readonly text: string;
  private readonly frames: ContainerFrame[] = [];
  private position = 0;
  private readonly punctuationHandlers = new Map<string, () => void>([
    [
      '{',
      () => {
        this.openContainer('object');
      },
    ],
    [
      '[',
      () => {
        this.openContainer('array');
      },
    ],
    [
      '}',
      () => {
        this.frames.pop();
      },
    ],
    [
      ']',
      () => {
        this.frames.pop();
      },
    ],
    [
      ',',
      () => {
        this.startNextEntry();
      },
    ],
  ]);

  constructor(text: string) {
    this.text = text;
  }

  scan(): void {
    while (this.position < this.text.length) {
      if (this.text[this.position] === '"') this.readString();
      else this.readPunctuation();
    }
  }

  private readPunctuation(): void {
    this.punctuationHandlers.get(this.text[this.position] ?? '')?.();
    this.position += 1;
  }

  /** Index of the quote closing the string that starts at `this.position`, or the text length. */
  private closingQuoteIndex(): number {
    let end = this.position + 1;
    // Bounded by the text length, so even malformed input can never loop forever.
    while (end < this.text.length && this.text[end] !== '"') end += this.text[end] === '\\' ? 2 : 1;
    return end;
  }

  private readString(): void {
    const end = this.closingQuoteIndex();
    const isTerminated = end < this.text.length;
    const value = isTerminated
      ? (JSON.parse(this.text.slice(this.position, end + 1)) as string)
      : '';
    this.position = Math.min(end + 1, this.text.length);
    if (isTerminated) this.registerKeyIfExpected(value);
  }

  private registerKeyIfExpected(key: string): void {
    const frame = this.frames.at(-1);
    if (frame?.kind !== 'object' || !frame.expectsKey) return;
    if (frame.keys.has(key)) this.duplicatePaths.push(childPath(frame.path, key));
    frame.keys.add(key);
    frame.expectsKey = false;
    frame.lastKey = key;
  }

  private openContainer(kind: ContainerFrame['kind']): void {
    const path = this.pathOfCurrentValue();
    this.frames.push(
      kind === 'object'
        ? { kind, path, keys: new Set(), expectsKey: true, lastKey: '' }
        : { kind, path, index: 0 },
    );
  }

  private startNextEntry(): void {
    const frame = this.frames.at(-1);
    if (frame?.kind === 'object') frame.expectsKey = true;
    else if (frame) frame.index += 1;
  }

  private pathOfCurrentValue(): string {
    const frame = this.frames.at(-1);
    if (!frame) return '';
    return frame.kind === 'object'
      ? childPath(frame.path, frame.lastKey)
      : `${frame.path}/${String(frame.index)}`;
  }
}

/** Issue paths of keys that `JSON.parse` would silently collapse to their last value. */
export function duplicateKeyPaths(validJsonText: string): string[] {
  const scanner = new DuplicateKeyScanner(validJsonText);
  scanner.scan();
  return scanner.duplicatePaths;
}
