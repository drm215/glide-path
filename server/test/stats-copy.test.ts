// The app and website share the round stats code as two copies (Render only deploys server/,
// and the app can't load files from it). This keeps them identical.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test("the app's copy of round-stats.js matches the website's", () => {
  const website = read('../public/js/round-stats.js');
  // The app copy starts with a two-line comment explaining where it comes from.
  const app = read('../../lib/round-stats.js').split('\n').slice(2).join('\n');
  assert.equal(app, website, 'lib/round-stats.js and server/public/js/round-stats.js have drifted apart; copy the change to both');
});
