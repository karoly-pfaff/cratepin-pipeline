import assert from 'node:assert/strict';
import test from 'node:test';

import { outputUrlOf } from './output-urls.ts';

test('a URL is the URL path and the percent-encoded output path, never starting with "/"', () => {
  assert.equal(outputUrlOf('assets', 'app/images/x.png'), 'assets/app/images/x.png');
  assert.equal(outputUrlOf('', 'app/x.png'), 'app/x.png');
  assert.equal(outputUrlOf('media/gen', 'a b/#1 100%.PNG'), 'media/gen/a%20b/%231%20100%25.PNG');
  assert.equal(outputUrlOf('assets', 'Kécske.png'), 'assets/K%C3%A9cske.png');
  assert.equal(
    outputUrlOf('assets', 'Kécske.png'),
    'assets/Ke%CC%81cske.png',
    'a decomposed name is encoded as written',
  );
  assert.equal(outputUrlOf('assets', 'ok_~-.png'), 'assets/ok_~-.png');
});
