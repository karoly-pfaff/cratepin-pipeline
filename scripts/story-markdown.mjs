function normalizedText(text) {
  return text.trim().replaceAll(/\s+/gu, ' ');
}

function storySectionOf(story, markdown) {
  const sections = markdown.split(/^## /mu).slice(1);
  const matching = sections.filter((section) => section.startsWith(`${story.id} — `));
  const section = matching[0];
  if (matching.length !== 1 || section === undefined)
    throw new Error(`Missing or duplicate Markdown ${story.id}`);
  if (section.split('\n', 1)[0].trim() !== `${story.id} — ${story.title}`)
    throw new Error(`Title drift ${story.id}`);
  return section;
}

function fieldOf(section, name, storyId) {
  const marker = new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*`, 'mu');
  const pieces = section.split(marker);
  const body = pieces[1];
  if (pieces.length !== 2 || body === undefined)
    throw new Error(`Missing or duplicate ${name} ${storyId}`);
  return body.split(/^\*\*[A-Za-z][^*\n]*:\*\*/mu, 1)[0].trim();
}

function listOf(text, field, storyId) {
  if (text === '' || text === 'none') return [];
  if (!text.startsWith('- ')) throw new Error(`Invalid ${field} list ${storyId}`);
  return text.slice(2).split(/^- /mu).map(normalizedText);
}

function criteriaOf(section, storyId) {
  const pieces = section.split(/^Acceptance criteria:[ \t]*$/mu);
  const body = pieces[1];
  if (pieces.length !== 2 || body === undefined)
    throw new Error(`Missing or duplicate criteria ${storyId}`);
  return listOf(body.split(/^\*\*Verification:\*\*/mu, 1)[0].trim(), 'criteria', storyId);
}

function assertSameFieldContent(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label);
}

/** Every field belongs to this story section; formatting whitespace alone is immaterial. */
export function assertStoryMarkdownMatches(story, markdown) {
  const section = storySectionOf(story, markdown);
  const fields = {
    status: fieldOf(section, 'Status', story.id).split(/\s+/u, 1)[0],
    verification: normalizedText(fieldOf(section, 'Verification', story.id)),
    evidence: listOf(fieldOf(section, 'Evidence', story.id), 'evidence', story.id),
  };
  assertSameFieldContent(`Status drift ${story.id}`, fields.status, story.status);
  assertSameFieldContent(
    `Criteria drift ${story.id}`,
    criteriaOf(section, story.id),
    story.acceptance_criteria.map(normalizedText),
  );
  assertSameFieldContent(
    `Verification drift ${story.id}`,
    fields.verification,
    normalizedText(story.verification),
  );
  assertSameFieldContent(
    `Evidence drift ${story.id}`,
    fields.evidence,
    story.evidence.map(normalizedText),
  );
}
