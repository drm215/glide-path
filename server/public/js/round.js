import { $, pageData, setUpRoundMap } from './lib.js';
import { renderRoundSummary } from './summary.js';

const data = pageData();
if (data?.shots) {
  setUpRoundMap($('#map'), data.shots, data.layouts);
  const summary = renderRoundSummary(data.shots, data.layouts);
  if (summary) $('#round-summary')?.replaceWith(summary);
}
