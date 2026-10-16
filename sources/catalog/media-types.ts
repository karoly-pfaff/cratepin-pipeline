import type { MediaCategory } from '../config/pipeline-config.ts';

/** The formats the pipeline accepts as originals, by lower-case file extension. */
const MEDIA_TYPES_BY_EXTENSION = new Map([
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['svg', 'image/svg+xml'],
  ['webp', 'image/webp'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['avif', 'image/avif'],
  ['mp3', 'audio/mpeg'],
  ['ogg', 'audio/ogg'],
  ['opus', 'audio/opus'],
  ['wav', 'audio/wav'],
  ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['flac', 'audio/flac'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['ttf', 'font/ttf'],
  ['otf', 'font/otf'],
  ['json', 'application/json'],
]);

/** The media type prefix each category requires; `other` takes any supported format. */
const REQUIRED_TYPE_PREFIX: Readonly<Record<MediaCategory, string>> = {
  image: 'image/',
  voice: 'audio/',
  effects: 'audio/',
  music: 'audio/',
  other: '',
};

/** A path's last extension as written, without the dot; `""` when its file name has none. */
export function extensionOf(path: string): string {
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  const extensionStart = fileName.lastIndexOf('.');
  return extensionStart <= 0 ? '' : fileName.slice(extensionStart + 1);
}

/** The media type of a source path, judged by its extension in any letter case. */
export function mediaTypeOf(path: string): string | undefined {
  const extension = extensionOf(path);
  return extension === '' ? undefined : MEDIA_TYPES_BY_EXTENSION.get(extension.toLowerCase());
}

/** The usual extension of a media type: the first one listed for it, e.g. `jpg` for JPEG. */
export function canonicalExtensionOf(mediaType: string): string | undefined {
  for (const [extension, type] of MEDIA_TYPES_BY_EXTENSION)
    if (type === mediaType) return extension;
  return undefined;
}

/** True when a file of `mediaType` can belong to `category`, e.g. no PNG among voice lines. */
export function suitsCategory(category: MediaCategory, mediaType: string): boolean {
  return mediaType.startsWith(REQUIRED_TYPE_PREFIX[category]);
}
