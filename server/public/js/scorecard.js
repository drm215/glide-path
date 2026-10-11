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

// Holes are shown nine at a time, like the front and back nine of a paper scorecard.
const HOLES_PER_BLOCK = 9;

// A hole grid: labels down the left and a column per hole, in blocks of nine, with a total
// column after the last hole when any row has a total. Each row is { label, muted, className,
// cell(column), total }; columns need a `hole`. With `pickable`, cells carry data-hole so a
// click can pick that hole (the round map listens for it).
const gridHtml = (columns, rows, { pickable = false } = {}) => {
  const hasTotal = rows.some((row) => row.total !== undefined);
  const holeAttr = (column) => (pickable ? ` data-hole="${escape(column.hole)}"` : '');
  const blocks = Array.from({ length: Math.ceil(columns.length / HOLES_PER_BLOCK) }, (_, index) => columns.slice(index * HOLES_PER_BLOCK, (index + 1) * HOLES_PER_BLOCK));
  return `<div class="scorecard-blocks">${blocks.map((block, index) => {
    const total = hasTotal && index === blocks.length - 1;
    const head = `<thead><tr><th scope="col">Hole</th>${block.map((column) => `<th scope="col"${holeAttr(column)}>${escape(column.hole)}</th>`).join('')}${total ? '<th scope="col" class="total">Tot</th>' : ''}</tr></thead>`;
    const body = rows.map((row) => `<tr class="${[row.className, row.muted && 'muted'].filter(Boolean).join(' ')}"><th scope="row">${row.label}</th>`
      + `${block.map((column) => `<td${holeAttr(column)}>${row.cell(column)}</td>`).join('')}${total ? `<td class="total">${row.total ?? ''}</td>` : ''}</tr>`).join('');
    return `<div class="scorecard-wrap"><table class="scorecard">${head}<tbody>${body}</tbody></table></div>`;
  }).join('')}</div>`;
};

// A round's scorecard: each hole's length, par and score, then how it was played. Rows the round
// has nothing for are left out.
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
    // Scramble shows whenever it could apply (drives on holes with a par), as 0/0 with no chances.
    drives.length > 0 && pars.some((par) => par !== null) && { label: 'Scramble', cell: (hole) => (hole.scramble === null ? '' : hole.scramble ? '<span class="made" title="Par or better">✓</span>' : '<span class="missed" title="Over par">✕</span>'), total: `${scrambles.filter((hole) => hole.scramble).length}/${scrambles.length}` },
    greens.length > 0 && { label: 'Greens', cell: (hole) => (hole.green === 'c1' || hole.green === 'c2' ? icon(hole.green) : ''), total: fraction(greens.filter((hole) => hole.green !== 'missed').length, greens.length) },
    c1x.attempts > 0 && { label: 'C1X Putting', cell: (hole) => fraction(hole.c1x.made, hole.c1x.attempts), total: fraction(c1x.made, c1x.attempts) },
    c2.attempts > 0 && { label: 'C2 Putting', cell: (hole) => fraction(hole.c2.made, hole.c2.attempts), total: fraction(c2.made, c2.attempts) },
    holes.some((hole) => hole.throwInFeet !== null) && { label: 'Throw in (ft)', muted: true, cell: (hole) => escape(hole.throwInFeet), total: '' },
    penalties > 0 && { label: 'OB / Penalty', cell: (hole) => (hole.penalties ? icon('ob') : ''), total: escape(penalties) },
  ].filter(Boolean);
  return gridHtml(holes, rows, { pickable: true });
};

// Scores on each hole of a course across rounds: `holes` are { hole, par (or null), played,
// average (or null), best (or null) }. The average is colored against par; the best is marked
// like a scorecard score.
export const holeAveragesHtml = (holes) => (holes.length ? gridHtml(holes, [
  { label: 'Par', muted: true, cell: (hole) => escape(hole.par) },
  { label: 'Played', muted: true, cell: (hole) => escape(hole.played) },
  { label: 'Avg', cell: (hole) => (hole.average === null ? '' : `<strong class="${hole.par === null ? '' : hole.average < hole.par ? 'under' : hole.average > hole.par ? 'over' : ''}">${escape(hole.average.toFixed(1))}</strong>`) },
  { label: 'Best', className: 'score-row', cell: (hole) => (hole.best === null ? '' : scoreMark(hole.best, hole.par)) },
]) : '');
