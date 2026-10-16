import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { compareCodeUnits } from '../catalog/ordering.ts';
import { GENERATIONS_DIRECTORY } from '../output/generation/generation-layout.ts';
import type { GenerationLayout } from '../output/generation/generation-layout.ts';
import {
  GENERATION_LISTING_NAME,
  generationDigestOf,
  generationNameOf,
} from '../output/generation/generation-listing.ts';
import { isGenerationAt, unknownNameNotices } from '../output/generation/generation-root.ts';
import { readGenerationListing } from '../output/generation/listing-reading.ts';
import { unsafeFileIssues } from '../output/manifest/manifest-safety.ts';
import type { UnsafeValueContext } from '../output/manifest/manifest-safety.ts';
import type { ReportIssue } from '../report.ts';
import { manifestInvalid, treeIssuesOf } from './published-tree.ts';

/** One retained generation: its listing must name it, and its files must match the listing. */
async function generationIssues(retained: RetainedCheck, name: string): Promise<ReportIssue[]> {
  const directory = join(retained.layout.generations, name);
  const listing = await readGenerationListing(directory);
  if (listing === undefined) return [];
  const prefix = `${GENERATIONS_DIRECTORY}/${name}/`;
  const isNamed = generationNameOf(generationDigestOf(listing.text)) === name;
  const naming = isNamed
    ? []
    : [manifestInvalid(prefix, 'Its listing is not the generation its name says.')];
  return [
    ...naming,
    ...(await treeIssuesOf({ directory, prefix, toolFiles: [] }, listing)),
    ...unsafeFileIssues(`${prefix}${GENERATION_LISTING_NAME}`, listing.text, retained.context),
  ];
}

/** Where the generations are, which one is published and what must not ship. */
export interface RetainedCheck {
  readonly layout: GenerationLayout;
  readonly publishedGeneration: string;
  readonly context: UnsafeValueContext;
}

/**
 * In generation mode, everything else that ships besides the published generation: every
 * retained generation is audited against its own listing (which is scanned for unsafe values
 * too), and every entry the tool did not write (UNKNOWN_OUTPUT_NAME) blocks, since it would be
 * packaged with the game.
 */
export async function retainedGenerationIssues(retained: RetainedCheck): Promise<ReportIssue[]> {
  const { layout } = retained;
  const publishedName = generationNameOf(retained.publishedGeneration);
  const names = (await readdir(layout.generations).catch((): string[] => [])).toSorted(
    compareCodeUnits,
  );
  const issues: ReportIssue[] = [];
  for (const name of names) {
    if (name !== publishedName && (await isGenerationAt(layout, name))) {
      issues.push(...(await generationIssues(retained, name)));
    }
  }
  return [...(await unknownNameNotices(layout)), ...issues];
}
