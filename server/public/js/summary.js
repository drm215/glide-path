// Round summary for the website's round pages: totals, and breakdowns by throw type, disc,
// landing spot and quality. Built from the same throw data the maps use.
import { el } from './lib.js';
import { QUALITY_LABELS, quality, reliableDistances, scoringStats, summarizeRounds } from './round-stats.js';

const feet = (value) => (value === null || value === 0 ? '—' : `${Math.round(value).toLocaleString()} ft`);
const qualityText = (value) => (value === null ? '—' : `${value.toFixed(1)} / 3`);

const breakdownTable = (heading, rows) => el('table', { class: 'summary-table' },
  el('thead', {}, el('tr', {}, [heading, 'THROWS', 'AVG DISTANCE', 'LONGEST', 'AVG QUALITY'].map((label) => el('th', {}, label)))),
  el('tbody', {}, rows.map((row) => el('tr', {},
    el('td', {}, row.label), el('td', {}, row.count), el('td', {}, feet(row.averageFeet)), el('td', {}, feet(row.longestFeet)), el('td', {}, qualityText(row.averageQuality))))));

const statTile = (label, value, note) => el('div', { class: 'stat' },
  el('div', { class: 'label' }, label), el('div', { class: 'value' }, value), note ? el('div', { class: 'stat-note' }, note) : null);

const THROW_TYPES = ['Drive', 'Approach', 'Putt'];

// A row of toggle buttons; exactly one is pressed. `onSelect` gets the chosen value.
const filterGroup = (label, options, onSelect) => {
  const buttons = options.map(([value, text]) => el('button', {
    type: 'button',
    'aria-pressed': String(value === null),
    onclick: () => {
      buttons.forEach((button) => button.setAttribute('aria-pressed', String(button === buttonFor(value))));
      onSelect(value);
    },
  }, text));
  const buttonFor = (value) => buttons[options.findIndex(([option]) => option === value)];
  return el('div', { class: 'tabs', role: 'group', 'aria-label': label }, buttons);
};

// The By disc table with throw-type and quality filters that combine. `reliable` comes from the
// full rounds, since a filtered list of throws no longer shows each throw's previous lie.
const discBreakdown = (shots, reliable) => {
  const filters = { type: null, quality: null };
  const types = THROW_TYPES.filter((type) => shots.some((shot) => shot.type === type));
  const ratings = [3, 2, 1].filter((value) => shots.some((shot) => quality(shot) === value));
  let table = null;
  const container = el('div', { class: 'disc-breakdown' });

  const render = () => {
    const matching = shots.filter((shot) => (filters.type === null || shot.type === filters.type) && (filters.quality === null || quality(shot) === filters.quality));
    const next = matching.length
      ? breakdownTable('DISC', summarizeRounds([{ shots: matching }], reliable).byDisc)
      : el('p', { class: 'meta' }, 'No throws match these filters.');
    if (table) table.replaceWith(next);
    else container.append(next);
    table = next;
  };

  if (types.length > 1) container.append(filterGroup('Filter by throw type', [[null, 'All throws'], ...types.map((type) => [type, type])], (value) => { filters.type = value; render(); }));
  if (ratings.length > 1) container.append(filterGroup('Filter by throw quality', [[null, 'Any quality'], ...ratings.map((value) => [value, QUALITY_LABELS[value]])], (value) => { filters.quality = value; render(); }));
  render();
  return container;
};

// One percentage bar: `count` of `of` filled, with an optional inner share (C1 inside C2).
const statBar = (count, of, inner, ...label) => {
  const fill = (value, outer) => {
    const share = Math.round((value / of) * 100);
    return el('span', { class: outer ? 'fill outer' : 'fill', style: `width: ${share}%` }, share >= 12 ? `${share}%` : null);
  };
  return el('div', { class: 'bar-row' },
    el('div', { class: 'bar', role: 'img', 'aria-label': `${Math.round((count / of) * 100)}%` }, inner === null ? fill(count, false) : [fill(count, true), fill(inner, false)]),
    el('div', { class: 'bar-label' }, label));
};

const count = (made, of) => el('strong', {}, `${made}/${of}`);

// Scoring percentages: fairways, scrambles, greens in regulation and putting from the circles,
// then made-putt distances and out-of-bounds throws.
const scoringBars = (stats) => {
  if (!stats.holes) return null;
  const { fairway, scramble, greens, c1x, c2, madePutts, penalties } = stats;
  return el('div', { class: 'bars' },
    fairway.drives ? statBar(fairway.hit, fairway.drives, null, count(fairway.hit, fairway.drives), ' Fairway') : null,
    scramble.chances ? statBar(scramble.saved, scramble.chances, null, count(scramble.saved, scramble.chances), ' Scramble') : null,
    greens.holes ? statBar(greens.c2, greens.holes, greens.c1, count(greens.c1, greens.holes), ' C1R  ', count(greens.c2, greens.holes), ' C2R') : null,
    c1x.attempts ? statBar(c1x.made, c1x.attempts, null, count(c1x.made, c1x.attempts), ' C1X Putting') : null,
    c2.attempts ? statBar(c2.made, c2.attempts, null, count(c2.made, c2.attempts), ' C2 Putting') : null,
    madePutts.count ? el('p', { class: 'bar-note' },
      el('strong', {}, `${madePutts.averageFeet.toFixed(1)} ft`), ' avg putt  ', el('strong', {}, `${madePutts.totalFeet.toLocaleString()} ft`), ' total putt  ',
      el('strong', {}, `${madePutts.longestFeet} ft`), ' long') : null,
    el('p', { class: 'bar-note' }, el('strong', {}, penalties), ' OB  ', el('strong', {}, (penalties / stats.holes).toFixed(3).replace(/^0/, '')), ' OB rate'));
};

// `rounds` are [{ shots, layouts }].
const renderSummary = (title, rounds) => {
  const shots = rounds.flatMap((round) => round.shots);
  if (!shots.length) return null;
  const summary = summarizeRounds(rounds);
  return el('section', { class: 'round-summary', 'aria-labelledby': 'summary-heading' },
    el('h2', { id: 'summary-heading' }, title),
    scoringBars(scoringStats(rounds)),
    el('div', { class: 'stats' },
      statTile('THROWS', summary.count, summary.penalties === 1 ? '1 OB penalty' : summary.penalties ? `${summary.penalties} OB penalties` : 'No penalties'),
      statTile('TOTAL DISTANCE', feet(summary.totalFeet), 'Measured by GPS'),
      statTile('LONGEST', feet(summary.longest?.feet ?? null), summary.longest ? [summary.longest.disc, summary.longest.type?.toLowerCase()].filter(Boolean).join(' ') : null),
      statTile('AVG QUALITY', qualityText(summary.averageQuality), summary.qualities.length ? null : 'Not rated')),
    el('h3', {}, 'By throw type'),
    breakdownTable('TYPE', summary.byType),
    summary.byStyle.length ? [el('h3', {}, 'By throw style'), breakdownTable('STYLE', summary.byStyle)] : null,
    el('h3', {}, 'By disc'),
    discBreakdown(shots, reliableDistances(rounds)),
    summary.landings.length ? [el('h3', {}, 'Where throws landed'), el('div', { class: 'chips' }, summary.landings.map((item) => el('span', { class: 'chip' }, `${item.lie === 'Basket' ? 'In the basket' : item.lie} · ${item.count}`)))] : null,
    summary.qualities.length ? [el('h3', {}, 'Throw quality'), el('div', { class: 'chips' }, summary.qualities.map((item) => el('span', { class: 'chip' }, `${item.label} · ${item.count}`)))] : null,
  );
};

export const renderRoundSummary = (shots, layouts = []) => renderSummary('Round summary', [{ shots, layouts }]);

// Throw stats across many rounds, each with the layouts it was played on.
export const renderHistorySummary = (rounds) => renderSummary('Throw stats', rounds);
