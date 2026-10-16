/** Cuts a stream into parts of exactly `partBytes`; only the last part may be shorter. */
class PartSplitter {
  private readonly partBytes: number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(partBytes: number) {
    this.partBytes = partBytes;
  }

  /** The parts `chunk` completes; what is left waits for the next chunk. */
  completedBy(chunk: Uint8Array): Buffer[] {
    const parts: Buffer[] = [];
    let rest = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    while (this.pendingBytes + rest.length >= this.partBytes) {
      const needed = this.partBytes - this.pendingBytes;
      parts.push(this.takePartEndingWith(rest.subarray(0, needed)));
      rest = rest.subarray(needed);
    }
    this.keep(rest);
    return parts;
  }

  private keep(piece: Buffer): void {
    this.pending.push(piece);
    this.pendingBytes += piece.length;
  }

  private takePartEndingWith(lastPiece: Buffer): Buffer {
    const part = Buffer.concat([...this.pending, lastPiece]);
    this.pending = [];
    this.pendingBytes = 0;
    return part;
  }

  /** The last, shorter part, if any bytes are left. */
  remainder(): Buffer | undefined {
    return this.pendingBytes > 0 ? Buffer.concat(this.pending) : undefined;
  }
}

export async function* partsOf(
  body: AsyncIterable<Uint8Array>,
  partBytes: number,
): AsyncGenerator<Buffer> {
  const splitter = new PartSplitter(partBytes);
  for await (const chunk of body) yield* splitter.completedBy(chunk);
  const last = splitter.remainder();
  if (last !== undefined) yield last;
}
