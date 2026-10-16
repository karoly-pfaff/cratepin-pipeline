import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SCAN_CHUNK_BYTES = 64 * 1024;

// This is a targeted release-evidence scan, not a general secret detector. Callers add
// the exact credential canaries and storage authority used by their build environment.
export const RUNTIME_MARKERS = [
  'R2_READ_ACCESS_KEY_ID',
  'R2_READ_SECRET_ACCESS_KEY',
  'R2_WRITE_ACCESS_KEY_ID',
  'R2_WRITE_SECRET_ACCESS_KEY',
  'X-Amz-Signature',
  'X-Amz-Credential',
  'AWSAccessKeyId',
  'r2.cloudflarestorage.com',
];

function needlesFor(markers) {
  return markers.flatMap((marker, index) =>
    ['utf8', 'utf16le'].map((encoding) => ({
      label: `marker-${index + 1}`,
      bytes: Buffer.from(marker.toLowerCase(), encoding),
    })),
  );
}

function matchingLabels(window, needles) {
  // latin1 preserves byte offsets and binary content while folding ASCII marker casing.
  const folded = Buffer.from(window.toString('latin1').toLowerCase(), 'latin1');
  return needles.filter((needle) => folded.includes(needle.bytes)).map((needle) => needle.label);
}

async function scanFile(path, needles) {
  const scan = new FileScan(needles);
  for await (const chunk of createReadStream(path, { highWaterMark: SCAN_CHUNK_BYTES })) {
    scan.consume(chunk);
  }
  return scan.finish();
}

class FileScan {
  hash = createHash('sha256');
  bytes = 0;
  tail = Buffer.alloc(0);
  labels = new Set();

  constructor(needles) {
    this.needles = needles;
    this.overlap = Math.max(0, ...needles.map((needle) => needle.bytes.length - 1));
  }

  consume(chunk) {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    const window = Buffer.concat([this.tail, chunk]);
    for (const label of matchingLabels(window, this.needles)) this.labels.add(label);
    this.tail = window.subarray(Math.max(0, window.length - this.overlap));
  }

  finish() {
    return {
      bytes: this.bytes,
      sha256: this.hash.digest('hex'),
      markers: [...this.labels].toSorted(),
    };
  }
}

async function inventoryEntry(root, path, needles) {
  const absolute = join(root, path);
  const entryStat = await lstat(absolute);
  if (entryStat.isDirectory()) return inventoryDirectory(absolute, path, needles);
  if (!entryStat.isFile()) throw new Error('Runtime audit refuses links and special files');
  return [{ path, ...(await scanFile(absolute, needles)) }];
}

async function inventoryDirectory(root, prefix, needles) {
  const files = [];
  for (const name of (await readdir(root)).toSorted()) {
    const entries = await inventoryEntry(root, name, needles);
    files.push(
      ...entries.map((entry) => ({
        ...entry,
        path: [prefix, entry.path].filter(Boolean).join('/'),
      })),
    );
  }
  return files;
}

/** Hashes every file, including binary media. A hit reports only a numbered marker label.
 * Run against a quiescent, trusted build tree; this does not defend against concurrent swaps.
 */
export async function auditRuntimeTree(root, markers = RUNTIME_MARKERS) {
  if (!(await lstat(root)).isDirectory()) throw new Error('Runtime audit needs a real directory');
  if (markers.some((marker) => marker.length === 0)) throw new Error('Empty audit marker');
  return inventoryDirectory(root, '', needlesFor(markers));
}
