import { crc32, deflateSync } from 'node:zlib';

import sharp from 'sharp';

export interface RawImage {
  readonly pixels: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * RGBA artwork whose alpha runs through 0, 1, 128, 254 and 255, with distinct colours also under
 * fully transparent pixels, so any change to alpha or to hidden colour is visible.
 */
export function transparentArtwork(width = 7, height = 5): RawImage {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels[index * 4] = (index * 37) % 256;
    pixels[index * 4 + 1] = (index * 91) % 256;
    pixels[index * 4 + 2] = (index * 13) % 256;
    pixels[index * 4 + 3] = [0, 1, 128, 254, 255][index % 5] ?? 255;
  }
  return { pixels, width, height };
}

export function pngOf(image: RawImage): Promise<Buffer> {
  const { width, height } = image;
  return sharp(image.pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/** The RGBA pixels of any image, as stored (an embedded colour profile is not applied). */
export async function storedPixelsOf(bytes: Uint8Array): Promise<RawImage> {
  const decoded = await sharp(bytes, { ignoreIcc: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { pixels: decoded.data, width: decoded.info.width, height: decoded.info.height };
}

/** An opaque PNG tagged with the Display P3 colour profile. */
export function displayP3Png(): Promise<Buffer> {
  const background = { r: 200, g: 100, b: 50 };
  return sharp({ create: { width: 2, height: 2, channels: 3, background } })
    .png()
    .withIccProfile('p3')
    .toBuffer();
}

/** A PNG with 16 bits per sample. */
export function sixteenBitPng(): Promise<Buffer> {
  const pixels = Buffer.alloc(2 * 2 * 4 * 2);
  for (let offset = 0; offset < pixels.length; offset += 2)
    pixels.writeUInt16LE(1000 + offset * 300, offset);
  // Sharp reads 16-bit raw input (`depth`), which its type for raw options does not list.
  const raw = { width: 2, height: 2, channels: 4 as const, depth: 'ushort' };
  return sharp(pixels, { raw }).toColourspace('rgb16').png().toBuffer();
}

/** One PNG chunk: length, type, content and checksum. */
export function pngChunk(type: string, content: Buffer): Buffer {
  const typeAndContent = Buffer.concat([Buffer.from(type, 'latin1'), content]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(content.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndContent));
  return Buffer.concat([length, typeAndContent, checksum]);
}

/** The PNG with `chunks` right after its header chunk. */
export function withChunksAfterHeader(png: Buffer, chunks: readonly Buffer[]): Buffer {
  const headerEnd = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, headerEnd), ...chunks, png.subarray(headerEnd)]);
}

/**
 * The PNG with an animation control chunk (`acTL`, one frame, played once) right after its
 * header, which makes it an animated PNG to readers that support APNG.
 */
export function withAnimationControl(png: Buffer): Buffer {
  const control = Buffer.alloc(8);
  control.writeUInt32BE(1, 0);
  return withChunksAfterHeader(png, [pngChunk('acTL', control)]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The contents of every chunk of `type` in the PNG, in file order. */
export function chunkContentsOf(png: Buffer, type: string): Buffer[] {
  const contents: Buffer[] = [];
  for (let offset = PNG_SIGNATURE.length; offset + 8 <= png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('latin1', offset + 4, offset + 8) === type) {
      contents.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  return contents;
}

/** An APNG frame control: the frame covers the whole canvas and shows for a tenth of a second. */
function frameControl(sequence: number, width: number, height: number): Buffer {
  const control = Buffer.alloc(26);
  control.writeUInt32BE(sequence, 0);
  control.writeUInt32BE(width, 4);
  control.writeUInt32BE(height, 8);
  control.writeUInt16BE(1, 20);
  control.writeUInt16BE(10, 22);
  return pngChunk('fcTL', control);
}

/** One APNG frame: its control chunk, then its image data (`IDAT` first, `fdAT` after). */
function animationFrame(png: Buffer, index: number, sequence: number): Buffer[] {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const imageData = Buffer.concat(chunkContentsOf(png, 'IDAT'));
  if (index === 0) return [frameControl(sequence, width, height), pngChunk('IDAT', imageData)];
  const numbered = Buffer.alloc(4);
  numbered.writeUInt32BE(sequence + 1);
  return [
    frameControl(sequence, width, height),
    pngChunk('fdAT', Buffer.concat([numbered, imageData])),
  ];
}

/**
 * A real animated PNG of the given frames (PNGs of one size and pixel format), each with its
 * frame control, played forever.
 */
export function animatedPng(frames: readonly Buffer[]): Buffer {
  const [first] = frames;
  if (first === undefined) throw new Error('An animation needs frames');
  const control = Buffer.alloc(8);
  control.writeUInt32BE(frames.length, 0);
  const chunks = frames.flatMap((frame, index) =>
    animationFrame(frame, index, Math.max(0, index * 2 - 1)),
  );
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', chunkContentsOf(first, 'IHDR')[0] ?? Buffer.alloc(13)),
    pngChunk('acTL', control),
    ...chunks,
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** How many frames an animated PNG says it has and how many frame controls it holds. */
export function animationFrameCounts(png: Buffer): { announced: number; controls: number } {
  return {
    announced: chunkContentsOf(png, 'acTL')[0]?.readUInt32BE(0) ?? 0,
    controls: chunkContentsOf(png, 'fcTL').length,
  };
}

/**
 * A PNG whose header announces `width`×`height` RGBA pixels but whose data holds almost none: a
 * huge image's header without its memory, for size checks made before decoding.
 */
export function headerOnlyPng(width: number, height: number, bitDepth = 8): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.alloc(64))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The PNG with a run of bytes inside its compressed pixel data inverted. */
export function withDamagedPixelData(png: Buffer): Buffer {
  const damaged = Buffer.from(png);
  for (let offset = 200; offset < 260; offset += 1) damaged[offset] = (damaged[offset] ?? 0) ^ 0xff;
  return damaged;
}

/**
 * Pseudo-random noise (xorshift32) that deflate cannot shrink, so truncating or damaging the
 * PNG anywhere after its header lands in the pixel data.
 */
export function noiseArtwork(width = 256, height = 256): RawImage {
  const pixels = Buffer.alloc(width * height * 4);
  let state = 0x9e3779b9;
  for (let index = 0; index < pixels.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[index] = state & 0xff;
  }
  return { pixels, width, height };
}

/** A 4-colour palette PNG of noise: tiny as PNG, much larger as lossy WebP. */
export function paletteNoisePng(): Promise<Buffer> {
  const { pixels, width, height } = noiseArtwork(128, 128);
  const rgb = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1)
    pixels.copy(rgb, index * 3, index * 4, index * 4 + 3);
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .png({ palette: true, colours: 4, dither: 0 })
    .toBuffer();
}

/** A smooth opaque gradient, as large backgrounds are: lossy WebP shrinks it a lot. */
export function gradientBackgroundPng(): Promise<Buffer> {
  const width = 512;
  const height = 256;
  const rgb = Buffer.alloc(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = (row * width + column) * 3;
      rgb[offset] = Math.floor(column / 2);
      rgb[offset + 1] = row;
      rgb[offset + 2] = 128;
    }
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** RGBA pixels of `width`×`height`, each the colour `colourAt` gives for its column and row. */
export function pixelsOf(
  width: number,
  height: number,
  colourAt: (column: number, row: number) => readonly number[],
): RawImage {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const colour = colourAt(index % width, Math.floor(index / width));
    pixels.set(colour.slice(0, 4), index * 4);
  }
  return { pixels, width, height };
}

/** A one-row 16-bit grey PNG holding exactly `samples`, written byte by byte. */
export function sixteenBitGreyPng(samples: readonly number[]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(samples.length, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 16;
  const row = Buffer.alloc(1 + samples.length * 2);
  samples.forEach((sample, index) => row.writeUInt16BE(sample, 1 + index * 2));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(row)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
