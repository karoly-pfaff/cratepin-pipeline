import { PipelineError } from '../errors.ts';

/** Why an original cannot be converted with its profile; each message names what to change. */
export type MediaFailureReason =
  | 'IMAGE_UNREADABLE'
  | 'IMAGE_TOO_LARGE'
  | 'UNSUPPORTED_IMAGE_FORMAT'
  | 'ANIMATION_UNSUPPORTED'
  | 'WEBP_EDGE_TOO_LONG'
  | 'ENCODING_FAILED'
  | 'PROFILE_UNKNOWN'
  | 'MEDIA_NOT_IMAGE'
  | 'ROLE_NEEDS_COPY'
  | 'ROLE_NEEDS_EXACT_PIXELS';

/** A conversion failure: INVALID_DATA (exit 8) with the reason in `details.reason`. */
export function mediaFailure(
  reason: MediaFailureReason,
  message: string,
  details: Readonly<Record<string, string | number>> = {},
): PipelineError {
  return new PipelineError('INVALID_DATA', message, { reason, ...details });
}
