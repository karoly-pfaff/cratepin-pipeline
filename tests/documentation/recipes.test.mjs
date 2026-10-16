import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseDocumentationRecipes } from '../../scripts/documentation-recipes.mjs';

const MARKDOWN = await readFile(new URL('../../docs/recipes.md', import.meta.url), 'utf8');

test('checked fences preserve executable source and tolerate CRLF line endings', () => {
  const recipes = parseDocumentationRecipes(MARKDOWN);
  assert.equal(recipes.size, 6);
  assert.match(recipes.get('preview'), /from '@karoly-pfaff\/cratepin'/u);
  assert.match(recipes.get('inspect'), /cratepin hash assets\/source\/ui\/icon.svg --json/u);
  assert.deepEqual(parseDocumentationRecipes(MARKDOWN.replaceAll('\n', '\r\n')), recipes);
});

test('missing, duplicate, empty and incorrectly typed recipes cannot be silently untested', () => {
  const mutations = [
    '',
    MARKDOWN.replace('recipe=preview', 'recipe=unknown'),
    MARKDOWN.replace('ts recipe=preview', 'sh recipe=preview'),
    `${MARKDOWN}\n\`\`\`sh recipe=planned\ncratepin remote gc --json\n\`\`\`\n`,
    MARKDOWN.replace(/(```sh recipe=planned\n)[\s\S]*?(```)/u, '$1$2'),
    `${MARKDOWN}\n\`\`\`sh\ncratepin push --json\n\`\`\`\n`,
  ];
  for (const markdown of mutations) assert.throws(() => parseDocumentationRecipes(markdown));
});
