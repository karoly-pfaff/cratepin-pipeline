import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { assertStoryMarkdownMatches } from './story-markdown.mjs';

const BACKLOG_DIRECTORY = new URL('../.local/backlog/', import.meta.url);
const STORY_STATES = new Set(['planned', 'in_progress', 'done', 'blocked', 'deferred']);
const MIN_ACCEPTANCE_CRITERIA = 3;
const REQUIREMENT_ROW = /\| (R-\d+) \|/g;

const readBacklogText = (name) => readFile(new URL(name, BACKLOG_DIRECTORY), 'utf8');

function failPlanCheck(message) {
  throw new Error(message);
}

function isNonemptyText(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

function isTextList(entries) {
  return Array.isArray(entries) && entries.every(isNonemptyText);
}

function assertValidStoryState(story) {
  if (!STORY_STATES.has(story.status)) failPlanCheck(`Invalid state ${story.id}`);
  if (!isTextList(story.evidence)) failPlanCheck(`Invalid evidence ${story.id}`);
  if (story.status === 'done' && story.evidence.length === 0)
    failPlanCheck(`Missing evidence ${story.id}`);
}

function assertStoryComplete(story) {
  const hasCriteria =
    isTextList(story.acceptance_criteria) &&
    story.acceptance_criteria.length >= MIN_ACCEPTANCE_CRITERIA;
  if (!hasCriteria || !isNonemptyText(story.verification)) failPlanCheck(`Incomplete ${story.id}`);
}

function assertStoryFields(story) {
  assertValidStoryState(story);
  assertStoryComplete(story);
}

async function loadValidatedStories(plan) {
  const epics = new Set(plan.epics.map((epic) => epic.id));
  const stories = new Map();
  for (const story of plan.stories) {
    if (stories.has(story.id) || !epics.has(story.epic))
      failPlanCheck(`Invalid identity ${story.id}`);
    assertStoryFields(story);
    assertStoryMarkdownMatches(story, await readBacklogText(`${story.epic.toLowerCase()}.md`));
    stories.set(story.id, story);
  }
  return stories;
}

function assertNoDependencyCycles(stories) {
  const visited = new Set();
  const visiting = new Set();
  const visitStory = (id) => {
    if (visiting.has(id)) failPlanCheck(`Dependency cycle ${id}`);
    if (visited.has(id)) return;
    const story = stories.get(id) ?? failPlanCheck(`Unknown dependency ${id}`);
    visiting.add(id);
    story.depends_on.forEach(visitStory);
    visiting.delete(id);
    visited.add(id);
  };
  [...stories.keys()].forEach(visitStory);
}

async function assertRequirementsMapped(stories) {
  const requirementsText = await readBacklogText('../docs/requirements.md');
  const definedRequirements = new Set(
    [...requirementsText.matchAll(REQUIREMENT_ROW)].map((match) => match[1]),
  );
  const mappedRequirements = new Set([...stories.values()].flatMap((story) => story.requirements));
  const unknownRequirements = [...mappedRequirements].filter((id) => !definedRequirements.has(id));
  const unmappedRequirements = [...definedRequirements].filter((id) => !mappedRequirements.has(id));
  if (unknownRequirements.length > 0)
    failPlanCheck(`Unknown requirement ${unknownRequirements.join(', ')}`);
  if (unmappedRequirements.length > 0)
    failPlanCheck(`Unmapped requirement ${unmappedRequirements.join(', ')}`);
  return definedRequirements.size;
}

async function checkLocalWorkPlan() {
  const plan = JSON.parse(await readBacklogText('backlog.json'));
  const stories = await loadValidatedStories(plan);
  assertNoDependencyCycles(stories);
  const requirementCount = await assertRequirementsMapped(stories);
  console.log(
    `${plan.epics.length} epics, ${stories.size} stories, ${requirementCount} requirements; dependency and Markdown checks pass.`,
  );
}

// The backlog is private and unversioned, so clean checkouts (CI) legitimately lack it.
if (existsSync(new URL('backlog.json', BACKLOG_DIRECTORY))) await checkLocalWorkPlan();
else console.log('No local work plan; work plan check skipped.');
