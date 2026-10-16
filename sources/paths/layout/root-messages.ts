/** Shared wording for root-separation issues, so lexical and real-path checks read the same. */

export function overlapMessage(otherRootPath: string): string {
  return `Overlaps ${otherRootPath}; each root needs its own directory`;
}

export const PROTECTED_DIRECTORY_MESSAGE = 'Must not be inside .git, .hg, .svn or node_modules';

/** No root and no lock may lie in a work directory, where builds stage, swap and remove output. */
export const WORK_DIRECTORY_MESSAGE =
  'Must not be or lie in a directory named .<name>.cratepin, where builds stage, swap and remove output';

export function insideRootMessage(rootPath: string): string {
  return `Must not be inside ${rootPath}`;
}
