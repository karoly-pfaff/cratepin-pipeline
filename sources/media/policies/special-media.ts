import { assertConvertibleFormat } from './conversion-checks.ts';
import { probeImage } from '../encoding/image-probe.ts';
import type { ImageFacts } from '../encoding/image-probe.ts';
import { mediaFailure } from '../media-failures.ts';
import type { ImagePolicy } from './transform-policy.ts';

/**
 * Roles whose pixels are data rather than a picture (sprite cells at fixed coordinates, atlas
 * regions, mask and data values): an image profile may only store every sample exactly as it is.
 */
const EXACT_PIXEL_ROLES: ReadonlySet<string> = new Set(['sprite', 'atlas', 'mask', 'data']);

/** Roles kept as the pinned master itself, such as a full-resolution print source. */
export const COPY_ONLY_ROLES: ReadonlySet<string> = new Set(['print-master']);

/** What the lock says about an original that decides which profiles may touch it. */
export interface MediaTypeAndRole {
  readonly mediaType: string;
  readonly role?: string;
}

const COPY_REMEDY =
  'give it the copy profile: "profile": "copy" in its assets entry, or a profile rule or defaultProfile that picks copy for it';

/** What storing an exact-pixel original with a profile would change, as a stable code. */
const SAMPLE_CHANGES = {
  RESIZE: 'the profile resizes it',
  NOT_LOSSLESS_WEBP: 'the profile does not store lossless WebP',
  COLOUR_PROFILE: 'its colour profile would be converted to sRGB',
  HIGH_PRECISION: 'its samples of more than 8 bits would be reduced to 8',
  PALETTE: 'its palette indices would become colours',
  LOW_BIT_DEPTH: 'its samples of fewer than 8 bits would be widened to 8',
} as const;

type SampleChange = keyof typeof SAMPLE_CHANGES;

/** Only lossless WebP without a resize can store an exact-pixel original unchanged. */
function policyChangesOf(policy: ImagePolicy): SampleChange[] {
  const isLosslessWebp = policy.output.format === 'webp' && policy.output.lossless;
  return [
    ...(policy.resize === null ? [] : (['RESIZE'] as const)),
    ...(isLosslessWebp ? [] : (['NOT_LOSSLESS_WEBP'] as const)),
  ];
}

/** What the conversion itself would change in the stored samples, from the header alone. */
function storedChangesOf(facts: ImageFacts): SampleChange[] {
  const changes: SampleChange[] = [];
  if (facts.hasColourProfile) changes.push('COLOUR_PROFILE');
  if (facts.bitsPerSample > 8) changes.push('HIGH_PRECISION');
  if (facts.isPalette) changes.push('PALETTE');
  else if (facts.bitsPerSample < 8) changes.push('LOW_BIT_DEPTH');
  return changes;
}

async function assertSamplesKept(
  { role, bytes }: { readonly role: string; readonly bytes: Uint8Array },
  policy: ImagePolicy,
): Promise<void> {
  const facts = await probeImage(bytes);
  // Another format or an animation is refused for its own reason, with its own remedy.
  assertConvertibleFormat(facts);
  const storedChanges = storedChangesOf(facts);
  const changes = [...policyChangesOf(policy), ...storedChanges];
  if (changes.length === 0) return;
  const reasons = changes.map((change) => SAMPLE_CHANGES[change]).join('; ');
  // When only the profile is at fault, another profile also keeps every sample.
  const remedy =
    storedChanges.length === 0
      ? `use lossless WebP without a resize, or ${COPY_REMEDY}`
      : COPY_REMEDY;
  throw mediaFailure(
    'ROLE_NEEDS_EXACT_PIXELS',
    `Role "${role}" keeps every pixel where and as it is, but ${reasons}; ${remedy}.`,
    { role, changes: changes.join(',') },
  );
}

/**
 * Refuses an image profile on what it must not convert, reading at most the image's header: a
 * file that is not an image (voice, effects, music and other data keep their bytes), a copy-only
 * role, or an exact-pixel role whose samples the profile or the conversion would change. It must
 * run before any conversion, and before a derivative cache looks anything up, as the role is not
 * part of the derivative key.
 */
export async function assertConversionAllowed(
  original: MediaTypeAndRole & { readonly bytes: Uint8Array },
  policy: ImagePolicy,
): Promise<void> {
  const { mediaType, role, bytes } = original;
  if (!mediaType.startsWith('image/')) {
    throw mediaFailure(
      'MEDIA_NOT_IMAGE',
      `Image profiles convert images, and this ${mediaType} file keeps its bytes; ${COPY_REMEDY}.`,
      { mediaType },
    );
  }
  if (role === undefined) return;
  if (COPY_ONLY_ROLES.has(role)) {
    throw mediaFailure(
      'ROLE_NEEDS_COPY',
      `Role "${role}" keeps the pinned full-resolution master, never a converted screen version; ${COPY_REMEDY}.`,
      { role },
    );
  }
  if (EXACT_PIXEL_ROLES.has(role)) await assertSamplesKept({ role, bytes }, policy);
}
