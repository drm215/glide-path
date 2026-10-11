import { $, pageData, setUpRoundMap } from './lib.js';
import { setUpRound3d } from './hole3d.js';
import { renderRoundSummary } from './summary.js';

const data = pageData();
if (data?.shots) {
  const shown = setUpRoundMap($('#map'), data.shots, data.layouts);
  if (shown) {
    setUpRound3d($('#map'), {
      firstHole: shown.first,
      rowsRoot: document,
      onShowMap: () => shown.map.invalidateSize(),
      optionsFor: (hole) => ({ hole, layout: data.layouts[hole - 1] ?? null, rounds: [{ id: 'round', label: 'This round', shots: data.shots }] }),
    });
  }
  const summary = renderRoundSummary(data.shots, data.layouts);
  if (summary) $('#round-summary')?.replaceWith(summary);
}
