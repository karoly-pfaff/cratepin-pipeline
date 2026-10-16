/**
 * The manifest URL of an output: the configured URL path at which the output root is served,
 * then the output's path inside it with every segment percent-encoded. It is relative to the
 * host's public root and never starts with `/`, so `./` bases, subpaths and Capacitor all resolve
 * it; names of letters, digits and `._~-` stay exactly as written.
 */
export function outputUrlOf(outputUrlPath: string, outputPath: string): string {
  const encodedPath = outputPath.split('/').map(encodeURIComponent).join('/');
  return outputUrlPath === '' ? encodedPath : `${outputUrlPath}/${encodedPath}`;
}
