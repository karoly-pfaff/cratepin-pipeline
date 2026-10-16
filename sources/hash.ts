import { open, stat } from 'node:fs/promises';

import { hashOpenedFile } from './opened-file-hash.ts';

export interface FileDigest {
  readonly sha256: string;
  readonly bytes: number;
}

async function assertRegularFile(path: string): Promise<void> {
  const fileStats = await stat(path);
  if (!fileStats.isFile()) throw new Error('Expected a regular file');
}

export async function hashFile(path: string): Promise<FileDigest> {
  await assertRegularFile(path);
  const file = await open(path);
  try {
    return await hashOpenedFile(file);
  } finally {
    await file.close();
  }
}
