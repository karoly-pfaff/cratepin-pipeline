import { readFile } from 'node:fs/promises';

const RECIPES_URL = new URL('../docs/recipes.md', import.meta.url);
const RECIPE_FENCE = /^```([^\r\n]*)\r?\n([\s\S]*?)^```\s*$/gm;
const EXPECTED_RECIPES = new Map([
  ['preview', 'ts'],
  ['memory', 'ts'],
  ['inspect', 'sh'],
  ['build', 'sh'],
  ['conflict', 'sh'],
  ['planned', 'sh'],
]);

/** IDs bind the actual published code fences to the package check, not to copied test text. */
export function parseDocumentationRecipes(markdown) {
  const blocks = [...markdown.matchAll(RECIPE_FENCE)].map(parseRecipeFence);
  const recipes = new Map(blocks.map((block) => [block.id, block.source]));
  const hasInvalidBlock = blocks.some(
    (block) => EXPECTED_RECIPES.get(block.id) !== block.language || block.source.trim() === '',
  );
  if (hasInvalidBlock || recipes.size !== blocks.length || recipes.size !== EXPECTED_RECIPES.size)
    throw new Error('Documentation recipes must have exactly one correctly typed fence per ID');
  if ([...EXPECTED_RECIPES.keys()].some((id) => !recipes.has(id)))
    throw new Error('A required documentation recipe is missing');
  return recipes;
}

function parseRecipeFence(match) {
  const header = /^(ts|sh) recipe=([a-z-]+)$/u.exec(match[1]);
  if (!header) throw new Error('Every code fence in recipes.md needs a checked recipe ID');
  return {
    language: header[1],
    id: header[2],
    source: match[2].replaceAll('\r\n', '\n').trim() + '\n',
  };
}

export async function loadDocumentationRecipes() {
  return parseDocumentationRecipes(await readFile(RECIPES_URL, 'utf8'));
}
