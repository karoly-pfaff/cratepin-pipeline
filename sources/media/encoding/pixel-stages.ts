import sharp from 'sharp';
import type { OutputInfo, Sharp } from 'sharp';

import './sharp-settings.ts';

import type { PipelineError } from '../../errors.ts';
import { mediaFailure } from '../media-failures.ts';
import type { ImagePolicy } from '../policies/transform-policy.ts';

// Kept out of image-encoding.ts: the public declarations must not need Node's or Sharp's types.

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

/** The original as Sharp input: decoded strictly, never past the configured pixel limit. */
function inputOf(bytes: Uint8Array, maxImagePixels: number): Sharp {
  return sharp(bytes, { limitInputPixels: maxImagePixels, failOn: 'error' });
}

/**
 * The pipeline a policy stands for; every setting comes from the policy. Any change to what this
 * function does with them must raise the transform version (encoder-fingerprint.ts), or old
 * derivatives would be reused for new behaviour.
 */
function pipelineFor(bytes: Uint8Array, policy: ImagePolicy, maxImagePixels: number): Sharp {
  const { resize, output } = policy;
  const image = inputOf(bytes, maxImagePixels);
  const resized =
    resize === null
      ? image
      : image.resize({
          width: resize.width,
          height: resize.height,
          fit: resize.fit,
          kernel: resize.kernel,
          withoutEnlargement: !resize.enlarge,
          background: TRANSPARENT,
        });
  if (output.format === 'same') {
    return resized.png({ compressionLevel: output.pngCompressionLevel });
  }
  const { lossless, quality, alphaQuality, effort, exact } = output;
  return resized.webp({ lossless, quality, alphaQuality, effort, exact });
}

/**
 * Whether the original decodes completely: every row is read in one sequential pass and shrunk
 * to a single pixel, so it costs little memory. Run only after a conversion failed.
 */
async function isDecodable(bytes: Uint8Array, maxImagePixels: number): Promise<boolean> {
  try {
    await inputOf(bytes, maxImagePixels).resize(1, 1, { fit: 'fill' }).raw().toBuffer();
    return true;
  } catch {
    return false;
  }
}

/** The input's fault if it does not even decode, otherwise the encoder's with this profile. */
async function failureOf(bytes: Uint8Array, maxImagePixels: number): Promise<PipelineError> {
  if (!(await isDecodable(bytes, maxImagePixels))) {
    return mediaFailure(
      'IMAGE_UNREADABLE',
      'The image could not be decoded completely: its pixel data is damaged or truncated.',
    );
  }
  return mediaFailure(
    'ENCODING_FAILED',
    'The original was read but the encoder could not write it with this profile; try another profile.',
  );
}

/**
 * Converts the original in one streaming libvips pass. Only if that fails is the original
 * decoded once more on its own, to tell a damaged original from an encoder failure.
 */
export async function convertStreaming(
  bytes: Uint8Array,
  policy: ImagePolicy,
  maxImagePixels: number,
): Promise<{ readonly encoded: Buffer; readonly output: OutputInfo }> {
  try {
    const result = await pipelineFor(bytes, policy, maxImagePixels).toBuffer({
      resolveWithObject: true,
    });
    return { encoded: result.data, output: result.info };
  } catch {
    throw await failureOf(bytes, maxImagePixels);
  }
}
