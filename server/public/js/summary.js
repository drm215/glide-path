// Round summary for the website's round pages: totals, and breakdowns by throw type, disc,
// landing spot and quality. Built from the same throw data the maps use.
import { el } from './lib.js';
import { summarizeRound } from './round-stats.js';

const feet = (value) => (value === null || value === 0 ? '—' : `${Math.round(value).toLocaleString()} ft`);
const qualityText = (value) => (value === null ? '—' : `${value.toFixed(1)} / 3`);

const breakdownTable = (heading, rows) => el('table', { class: 'summary-table' },
  el('thead', {}, el('tr', {}, [heading, 'THROWS', 'AVG DISTANCE', 'LONGEST', 'AVG QUALITY'].map((label) => el('th', {}, label)))),
  el('tbody', {}, rows.map((row) => el('tr', {},
    el('td', {}, row.label), el('td', {}, row.count), el('td', {}, feet(row.averageFeet)), el('td', {}, feet(row.longestFeet)), el('td', {}, qualityText(row.averageQuality))))));

const percent = (count, total) => `${Math.round((count / total) * 100)}%`;

const statTile = (label, value, note) => el('div', { class: 'stat' },
  el('div', { class: 'label' }, label), el('div', { class: 'value' }, value), note ? el('div', { class: 'stat-note' }, note) : null);

export const renderRoundSummary = (shots, layouts = []) => {
  if (!shots.length) return null;
  const summary = summarizeRound(shots, layouts);
  const { putting } = summary;
  return el('section', { class: 'round-summary', 'aria-labelledby': 'summary-heading' },
    el('h2', { id: 'summary-heading' }, 'Round summary'),
    el('div', { class: 'stats' },
      statTile('THROWS', summary.count, summary.penalties === 1 ? '1 OB penalty' : summary.penalties ? `${summary.penalties} OB penalties` : 'No penalties'),
      statTile('TOTAL DISTANCE', feet(summary.totalFeet), 'Measured by GPS'),
      statTile('LONGEST', feet(summary.longest?.feet ?? null), summary.longest ? [summary.longest.disc, summary.longest.type?.toLowerCase()].filter(Boolean).join(' ') : null),
      statTile('AVG QUALITY', qualityText(summary.averageQuality), summary.qualities.length ? null : 'Not rated')),
    el('h3', {}, 'By throw type'),
    breakdownTable('TYPE', summary.byType),
    putting ? [
      el('h3', {}, 'Putting'),
      el('div', { class: 'stats' },
        statTile('FIRST-PUTT MAKES', `${Math.round((putting.firstPutts.made / putting.firstPutts.attempts) * 100)}%`, `${putting.firstPutts.made} of ${putting.firstPutts.attempts} holes`),
        statTile('AVG FIRST PUTT', feet(putting.firstPutts.averageFeet),
          putting.firstPutts.measured < putting.firstPutts.attempts ? `${putting.firstPutts.measured} of ${putting.firstPutts.attempts} measured` : 'From lie to basket'),
        statTile('ALL PUTTS', `${Math.round((putting.made / putting.attempts) * 100)}%`, `${putting.made} of ${putting.attempts} made`)),
      putting.hit || putting.missed ? el('p', { class: 'meta' }, [putting.hit ? `${putting.hit} hit the basket` : '', putting.missed ? `${putting.missed} missed` : ''].filter(Boolean).join(' · ')) : null,
    ] : null,
    summary.driveCircles.drives ? [
      el('h3', {}, 'Drives in the circles'),
      summary.driveCircles.measured ? [
        el('div', { class: 'stats' },
          statTile('IN C1', percent(summary.driveCircles.c1, summary.driveCircles.measured), `${summary.driveCircles.c1} of ${summary.driveCircles.measured} · within 33 ft (10 m)`),
          statTile('IN C2', percent(summary.driveCircles.c2, summary.driveCircles.measured), `${summary.driveCircles.c2} of ${summary.driveCircles.measured} · 33–66 ft (10–20 m)`),
          statTile('INSIDE C2', percent(summary.driveCircles.c1 + summary.driveCircles.c2, summary.driveCircles.measured), `${summary.driveCircles.c1 + summary.driveCircles.c2} of ${summary.driveCircles.measured} · within 66 ft`)),
        summary.driveCircles.measured < summary.driveCircles.drives
          ? el('p', { class: 'meta' }, `${summary.driveCircles.measured} of ${summary.driveCircles.drives} drives could be measured; the rest have no logged position or no mapped basket.`)
          : null,
      ] : el('p', { class: 'meta' }, 'Circle hits need a drive’s logged landing spot and the hole’s mapped basket, and no drive in this round has both.'),
    ] : null,
    el('h3', {}, 'By disc'),
    breakdownTable('DISC', summary.byDisc),
    summary.landings.length ? [el('h3', {}, 'Where throws landed'), el('div', { class: 'chips' }, summary.landings.map((item) => el('span', { class: 'chip' }, `${item.lie === 'Basket' ? 'In the basket' : item.lie} · ${item.count}`)))] : null,
    summary.qualities.length ? [el('h3', {}, 'Throw quality'), el('div', { class: 'chips' }, summary.qualities.map((item) => el('span', { class: 'chip' }, `${item.label} · ${item.count}`)))] : null,
  );
};
