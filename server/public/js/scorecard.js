// A round's score strip and scorecard as HTML, shared by the server-rendered round page and the
// My rounds view. Free of browser APIs so the server can render it; every value is escaped.
import { holeBreakdown } from './round-stats.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const formatToPar = (diff) => (diff === 0 ? 'E' : diff > 0 ? `+${diff}` : String(diff));
const sum = (values) => values.reduce((total, value) => total + value, 0);
const fraction = (count, of) => (of ? `${count}/${of}` : '');

// The score to par in a badge (the total when no hole has a par), then the total, par and the
// course length when every hole played is mapped.
export const scoreStripHtml = (shots, layouts = []) => {
  const holes = holeBreakdown(shots, layouts);
  const total = sum(holes.map((hole) => hole.strokes));
  const withPar = holes.filter((hole) => hole.par !== null);
  const toPar = withPar.length ? sum(withPar.map((hole) => hole.strokes - hole.par)) : null;
  const length = holes.length && holes.every((hole) => hole.lengthFeet !== null) ? sum(holes.map((hole) => hole.lengthFeet)) : null;
  const badgeClass = toPar === null ? '' : toPar < 0 ? ' under' : toPar > 0 ? ' over' : ' even';
  return `<div class="score"><span class="par${badgeClass}">${escape(toPar === null ? total : formatToPar(toPar))}</span>`
    + `<span class="figure">Total <strong class="total">${escape(total)}</strong></span>`
    + (withPar.length ? `<span class="figure">Par <strong>${escape(sum(withPar.map((hole) => hole.par)))}</strong></span>` : '')
    + (length === null ? '' : `<span class="figure">Dist <strong>${escape(length.toLocaleString('en-US'))} ft</strong></span>`)
    + '</div>';
};

// Circled under par (ringed for eagle or better), boxed over par.
const scoreMark = (strokes, par) => {
  const diff = par === null ? 0 : strokes - par;
  const shape = diff <= -2 ? 'eagle' : diff === -1 ? 'birdie' : diff === 1 ? 'bogey' : diff >= 2 ? 'double' : 'even';
  return `<span class="mark ${shape}">${escape(strokes)}</span>`;
};

const ICON_LABELS = { ace: 'Ace', c1: 'Inside C1', c2: 'Inside C2', fairway: 'Fairway', rough: 'Rough', ob: 'Out of bounds' };
const icon = (kind) => (kind ? `<span class="icon ${kind}" role="img" aria-label="${ICON_LABELS[kind]}" title="${ICON_LABELS[kind]}"></span>` : '');

const LEGEND = [['c1', 'C1'], ['c2', 'C2'], ['fairway', 'Fairway'], ['rough', 'Rough'], ['ob', 'OB'], ['ace', 'Ace']];
export const scorecardLegendHtml = () => `<p class="scorecard-legend">${LEGEND.map(([kind, label]) => `<span>${icon(kind)} ${label}</span>`).join('')}</p>`;

// Labels down the left, a column per hole (each cell marked with data-hole, for the map) and a
// total column. Rows the round has nothing for are left out.
export const scorecardHtml = (shots, layouts = []) => {
  const holes = holeBreakdown(shots, layouts);
  if (!holes.length) return '';
  const lengths = holes.map((hole) => hole.lengthFeet);
  const pars = holes.map((hole) => hole.par);
  const drives = holes.filter((hole) => hole.driving !== null);
  const scrambles = holes.filter((hole) => hole.scramble !== null);
  const greens = holes.filter((hole) => hole.green !== null);
  const putts = (key) => ({ made: sum(holes.map((hole) => hole[key].made)), attempts: sum(holes.map((hole) => hole[key].attempts)) });
  const c1x = putts('c1x');
  const c2 = putts('c2');
  const penalties = sum(holes.map((hole) => hole.penalties));
  const rows = [
    lengths.some((feet) => feet !== null) && { label: 'Distance (ft)', muted: true, cell: (hole) => escape(hole.lengthFeet), total: lengths.every((feet) => feet !== null) ? escape(sum(lengths)) : '' },
    pars.some((par) => par !== null) && { label: 'Par', muted: true, cell: (hole) => escape(hole.par), total: pars.every((par) => par !== null) ? escape(sum(pars)) : '' },
    { label: 'Score', className: 'score-row', cell: (hole) => scoreMark(hole.strokes, hole.par), total: `<strong>${escape(sum(holes.map((hole) => hole.strokes)))}</strong>` },
    drives.length > 0 && { label: 'Driving', cell: (hole) => icon(hole.driving), total: fraction(drives.filter((hole) => hole.driving !== 'rough' && hole.driving !== 'ob').length, drives.length) },
    scrambles.length > 0 && { label: 'Scramble', cell: (hole) => (hole.scramble === null ? '' : hole.scramble ? '<span class="made" title="Par or better">✓</span>' : '<span class="missed" title="Over par">✕</span>'), total: fraction(scrambles.filter((hole) => hole.scramble).length, scrambles.length) },
    greens.length > 0 && { label: 'Greens', cell: (hole) => (hole.green === 'c1' || hole.green === 'c2' ? icon(hole.green) : ''), total: fraction(greens.filter((hole) => hole.green !== 'missed').length, greens.length) },
    c1x.attempts > 0 && { label: 'C1X Putting', cell: (hole) => fraction(hole.c1x.made, hole.c1x.attempts), total: fraction(c1x.made, c1x.attempts) },
    c2.attempts > 0 && { label: 'C2 Putting', cell: (hole) => fraction(hole.c2.made, hole.c2.attempts), total: fraction(c2.made, c2.attempts) },
    holes.some((hole) => hole.throwInFeet !== null) && { label: 'Throw in (ft)', muted: true, cell: (hole) => escape(hole.throwInFeet), total: '' },
    penalties > 0 && { label: 'OB / Penalty', cell: (hole) => (hole.penalties ? icon('ob') : ''), total: escape(penalties) },
  ].filter(Boolean);
  const head = `<thead><tr><th scope="col">Hole</th>${holes.map((hole) => `<th scope="col" data-hole="${hole.hole}">${hole.hole}</th>`).join('')}<th scope="col" class="total">Tot</th></tr></thead>`;
  const body = rows.map((row) => `<tr class="${[row.className, row.muted && 'muted'].filter(Boolean).join(' ')}"><th scope="row">${row.label}</th>`
    + `${holes.map((hole) => `<td data-hole="${hole.hole}">${row.cell(hole)}</td>`).join('')}<td class="total">${row.total}</td></tr>`).join('');
  return `<div class="scorecard-wrap"><table class="scorecard">${head}<tbody>${body}</tbody></table></div>`;
};
