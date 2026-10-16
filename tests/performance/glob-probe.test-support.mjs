import { classifySources, selectIncludedFiles } from '../../sources/catalog/source-selection.ts';
import { defaultConfig } from '../../sources/config/pipeline-config.ts';
import { profileSelectorFor } from '../../sources/media/policies/profile-selection.ts';
import { compileGlob } from '../../sources/paths/matching/glob-matcher.ts';

const PATTERN = 'a*'.repeat(16) + 'b.png';
const NEAR_MISS = 'a'.repeat(64) + '.png';
const MATCH = 'a'.repeat(64) + 'b.png';

function configForProbe() {
  const config = defaultConfig();
  return {
    ...config,
    sources: {
      ...config.sources,
      categories: [
        { match: PATTERN, category: 'other' },
        { match: '**/*.png', category: 'image' },
      ],
    },
    profiles: { screen: { kind: 'image', resize: { width: 64, height: 64, fit: 'inside' } } },
    profileRules: [
      { match: PATTERN, profile: 'copy' },
      { match: '**/*.png', profile: 'screen' },
    ],
  };
}

function selectionFacts() {
  const files = [NEAR_MISS, MATCH];
  const config = configForProbe();
  const included = selectIncludedFiles(files, [PATTERN]);
  const classified = classifySources(files, config);
  const selectProfile = profileSelectorFor(config);
  return {
    hasNearMiss: compileGlob(PATTERN)(NEAR_MISS),
    hasMatch: compileGlob(PATTERN)(MATCH),
    includedCount: included.accepted.length,
    inclusionIssues: included.issues,
    categories: classified.accepted.map(({ category }) => category),
    classificationIssues: classified.issues,
    profiles: files.map((source) => selectProfile({ source }).name),
  };
}

process.on('message', () => {
  process.send(selectionFacts(), () => {
    process.disconnect();
  });
});
process.send('ready');
