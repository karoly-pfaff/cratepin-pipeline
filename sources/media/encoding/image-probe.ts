import sharp from 'sharp';
import type { Metadata } from 'sharp';

import './sharp-settings.ts';

import { mediaFailure } from '../media-failures.ts';

/** What the conversion needs to know about an image before it decodes the pixels. */
export interface ImageFacts {
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  readonly bitsPerSample: number;
  /** The pixels are indices into a palette (bitsPerSample is then the index's size). */
  readonly isPalette: boolean;
  readonly hasColourProfile: boolean;
  /** A multi-page GIF or WebP, or a PNG with animation control (`acTL`), even of one frame. */
  readonly isAnimated: boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The chunk types of a PNG in file order; stops at a chunk that runs past the end. */
function* pngChunkTypes(buffer: Buffer): Generator<string> {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    yield buffer.toString('latin1', offset + 4, offset + 8);
    offset += 12 + buffer.readUInt32BE(offset);
  }
}

/**
 * True for an animated PNG: an `acTL` chunk before the first `IDAT`. libvips reads only the
 * first frame of such a file and does not report it as animated, so the chunks are read here.
 */
function isAnimatedPng(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
  for (const type of pngChunkTypes(buffer)) {
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
  }
  return false;
}

/**
 * The header alone, whatever the size: Sharp's own pixel limit is switched off here so that
 * an image over the configured limit is reported as too large, never as unreadable.
 */
async function headerOf(bytes: Uint8Array): Promise<Metadata> {
  try {
    return await sharp(bytes, { limitInputPixels: false }).metadata();
  } catch {
    throw mediaFailure(
      'IMAGE_UNREADABLE',
      'The image cannot be read: it is damaged, truncated or not in the format its name says.',
    );
  }
}

/** Reads only the image's header; no pixel is decoded. */
export async function probeImage(bytes: Uint8Array): Promise<ImageFacts> {
  const header = await headerOf(bytes);
  return {
    format: header.format,
    width: header.width,
    height: header.height,
    hasAlpha: header.hasAlpha,
    bitsPerSample: header.bitsPerSample ?? 8,
    isPalette: header.isPalette,
    hasColourProfile: header.icc !== undefined,
    isAnimated: (header.pages ?? 1) > 1 || isAnimatedPng(bytes),
  };
}
