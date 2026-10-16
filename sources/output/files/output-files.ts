import { parseStrictJson } from '../../json/strict-json.ts';
import { checkRegularFile, readRegularFile } from '../../paths/files/regular-files.ts';
import type { FileMessages, FileReading, FileState } from '../../paths/files/regular-files.ts';
import type { ExpectedContent } from '../../storage/transfer/checked-body.ts';

const OUTPUT_FILE_MESSAGES: FileMessages = {
  cannotInspect: 'A file in the output directory cannot be inspected.',
  cannotOpen: 'A file in the output directory cannot be opened.',
  notRegular: 'A file in the output directory is not a regular file.',
};

/** A text file the tool writes into an output tree, such as the listing or the manifest. */
export interface ToolFile {
  readonly name: string;
  readonly text: string;
}

/** Checks an output file by hashing all of it; a link or directory at its name is `corrupt`. */
export function checkOutputFile(path: string, expected: ExpectedContent): Promise<FileState> {
  return checkRegularFile(path, expected, OUTPUT_FILE_MESSAGES);
}

/** Reads a whole output file of at most `maxBytes`, never through a link. */
export function readOutputFile(path: string, maxBytes: number): Promise<FileReading> {
  return readRegularFile(path, maxBytes, OUTPUT_FILE_MESSAGES);
}

/**
 * A JSON file the tool wrote, such as the marker, listing or manifest: its exact text and
 * strictly parsed value, `absent`, or `unreadable` (a link, too large, not strict JSON).
 */
export type ToolJsonReading =
  | { readonly state: 'parsed'; readonly text: string; readonly value: unknown }
  | { readonly state: 'absent' | 'unreadable' };

/** A listing or manifest larger than this is not one this tool wrote for any realistic project. */
export const MAX_TOOL_JSON_BYTES = 64 * 1024 * 1024;

/** Reads and strictly parses (a duplicated field is unreadable) a JSON file the tool wrote. */
export async function readToolJson(path: string, maxBytes: number): Promise<ToolJsonReading> {
  const reading = await readOutputFile(path, maxBytes);
  if (reading.state !== 'present') {
    return { state: reading.state === 'absent' ? 'absent' : 'unreadable' };
  }
  const text = new TextDecoder().decode(reading.bytes);
  const parsed = parseStrictJson(text);
  return parsed.ok ? { state: 'parsed', text, value: parsed.value } : { state: 'unreadable' };
}

/** The directories leading to a relative path, outermost first: `a/b/c.png` gives `a`, `a/b`. */
export function directoriesLeadingTo(path: string): string[] {
  const segments = path.split('/');
  return segments.slice(1).map((_segment, index) => segments.slice(0, index + 1).join('/'));
}
