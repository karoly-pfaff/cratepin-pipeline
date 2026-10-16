import { open } from 'node:fs/promises';

/** The leading bytes of each image type the tool publishes, checked against its media type. */
const SIGNATURES: readonly {
  readonly mediaType: string;
  readonly matches: (head: Buffer) => boolean;
}[] = [
  {
    mediaType: 'image/png',
    matches: (head) =>
      head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mediaType: 'image/webp',
    matches: (head) =>
      head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP',
  },
  {
    mediaType: 'image/gif',
    matches: (head) => ['GIF87a', 'GIF89a'].includes(head.toString('latin1', 0, 6)),
  },
  {
    mediaType: 'image/jpeg',
    matches: (head) => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  },
];

const HEAD_BYTES = 12;

async function headOf(path: string): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await file.read(head, 0, HEAD_BYTES, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/**
 * Whether a published file's content is what its media type says, for the image types the tool
 * publishes (PNG, WebP, GIF, JPEG): a renamed or stale file is caught even when its listing was
 * rewritten to match. Other media types are not sniffed and always pass.
 */
export async function hasContentOf(path: string, mediaType: string): Promise<boolean> {
  const signature = SIGNATURES.find((candidate) => candidate.mediaType === mediaType);
  if (signature === undefined) return true;
  return signature.matches(await headOf(path));
}
