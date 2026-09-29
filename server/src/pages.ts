// Minimal server-rendered pages for share links until the full website exists.

type Layout = { tee: unknown; basket: unknown; par?: number };
type PageShot = { hole: number; feet: number; disc?: string; type?: string; lie?: string };

const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const formatToPar = (diff: number) => (diff === 0 ? 'E' : diff > 0 ? `+${diff}` : String(diff));

// Matches the app: an out-of-bounds throw adds a penalty stroke.
const strokes = (shots: PageShot[]) => shots.length + shots.filter((shot) => shot.lie === 'OB').length;

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Glide Path</title>
<style>
  :root { --ink: #18231f; --muted: #737c70; --green: #1d684c; --paper: #f6f5ee; --card: #ffffff; --line: #e1e2d8; --over: #c0682f; }
  @media (prefers-color-scheme: dark) { :root { --ink: #ecefe8; --muted: #a3ab9f; --green: #6fbf97; --paper: #141a17; --card: #1d2521; --line: #2e3833; --over: #e59a66; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 24px 16px 48px; }
  .brand { color: var(--green); font-size: 12px; font-weight: 800; letter-spacing: .12em; }
  h1 { font-family: Georgia, serif; font-weight: 400; font-size: 32px; margin: 6px 0 4px; }
  .meta { color: var(--muted); margin: 0 0 20px; }
  .score { display: flex; gap: 12px; align-items: baseline; font-family: Georgia, serif; }
  .score .total { font-size: 48px; } .score .par { font-size: 26px; }
  .under { color: var(--green); } .over { color: var(--over); }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin: 16px 0; }
  th, td { padding: 8px 12px; text-align: center; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  th { color: var(--muted); font-size: 11px; letter-spacing: .08em; }
  td:first-child, th:first-child { text-align: left; }
  tfoot td { font-weight: 700; border-bottom: 0; }
  .notes { white-space: pre-wrap; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
  a { color: var(--green); }
  footer { color: var(--muted); font-size: 13px; margin-top: 32px; }
</style>
</head>
<body><main><div class="brand">GLIDE PATH</div>${body}<footer>Mapped and logged with Glide Path.</footer></main></body>
</html>`;

export const renderNotFoundPage = (what: string) =>
  page('Not found', `<h1>Not found</h1><p class="meta">This ${escapeHtml(what)} doesn't exist or is no longer shared.</p>`);

export const renderRoundPage = (round: { courseName: string; mode: string; shots: PageShot[]; playedBy: string; updatedAt: number; layouts: Layout[]; courseUid: string | null; layoutName?: string | null }) => {
  const holes = [...new Set(round.shots.map((shot) => shot.hole))].sort((a, b) => a - b).map((hole) => {
    const holeShots = round.shots.filter((shot) => shot.hole === hole);
    return { hole, score: strokes(holeShots), par: round.layouts[hole - 1]?.par };
  });
  const withPar = holes.filter((item) => item.par !== undefined);
  const total = strokes(round.shots);
  const toPar = withPar.length ? withPar.reduce((sum, item) => sum + item.score - item.par!, 0) : null;
  const parTotal = withPar.reduce((sum, item) => sum + item.par!, 0);
  const diffClass = (diff: number) => (diff < 0 ? 'under' : diff > 0 ? 'over' : '');
  const courseName = round.courseUid ? `<a href="/c/${escapeHtml(round.courseUid)}">${escapeHtml(round.courseName)}</a>` : escapeHtml(round.courseName);
  const played = new Date(round.updatedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return page(`${round.playedBy} at ${round.courseName}`, `
<h1>${courseName}</h1>
<p class="meta">${escapeHtml(round.mode === 'Practice' ? 'Practice session' : 'Round')} by ${escapeHtml(round.playedBy)} · ${escapeHtml(played)}${round.layoutName ? ` · ${escapeHtml(round.layoutName)} layout` : ''}</p>
<div class="score"><span class="total">${total}</span>${toPar === null ? '' : `<span class="par ${diffClass(toPar)}">${formatToPar(toPar)}</span>`}</div>
<table>
  <thead><tr><th>HOLE</th><th>PAR</th><th>SCORE</th><th>+/−</th></tr></thead>
  <tbody>${holes.map((item) => {
    const diff = item.par === undefined ? null : item.score - item.par;
    return `<tr><td>${String(item.hole).padStart(2, '0')}</td><td>${item.par ?? '—'}</td><td><strong>${item.score}</strong></td><td class="${diff === null ? '' : diffClass(diff)}">${diff === null ? '—' : formatToPar(diff)}</td></tr>`;
  }).join('')}</tbody>
  <tfoot><tr><td>TOTAL</td><td>${withPar.length ? parTotal : '—'}</td><td>${total}</td><td class="${toPar === null ? '' : diffClass(toPar)}">${toPar === null ? '—' : formatToPar(toPar)}</td></tr></tfoot>
</table>`);
};

type PageLayout = { name: string; holes: number; layouts: Layout[]; par: number | null; mappedHoles: number; distanceFeet: number };

const layoutTable = (layouts: Layout[]) => `<table>
  <thead><tr><th>HOLE</th><th>PAR</th><th>MAPPED</th></tr></thead>
  <tbody>${layouts.map((layout, index) => `<tr><td>${String(index + 1).padStart(2, '0')}</td><td>${layout.par ?? '—'}</td><td>${layout.tee && layout.basket ? 'Yes' : '—'}</td></tr>`).join('')}</tbody>
</table>`;

const layoutStats = (layout: Omit<PageLayout, 'name' | 'layouts'>) => [
  `${layout.holes} ${layout.holes === 1 ? 'hole' : 'holes'}`,
  layout.par === null ? null : `Par ${layout.par}`,
  layout.mappedHoles ? `${layout.distanceFeet.toLocaleString('en-US')} ft` : null,
].filter(Boolean).join(' · ');

export const renderCoursePage = (course: {
  name: string; holes: number; layouts: Layout[]; details: Record<string, string | undefined>; mappedBy: string;
  mappedHoles: number; par: number | null; distanceFeet: number; layoutName?: string; extraLayouts?: PageLayout[];
}) => {
  const street = course.details.street ?? course.details.address;
  const address = [street, course.details.city, course.details.state].map((part) => part?.trim()).filter(Boolean).join(', ');
  const stats = layoutStats(course);
  const extraLayouts = course.extraLayouts ?? [];
  const website = course.details.website?.trim();
  const websiteUrl = website && (/^https?:\/\//i.test(website) ? website : `https://${website}`);
  return page(course.name, `
<h1>${escapeHtml(course.name)}</h1>
<p class="meta">${escapeHtml(stats)} · mapped by ${escapeHtml(course.mappedBy)}</p>
${address ? `<p><a href="https://maps.apple.com/?q=${encodeURIComponent(address)}">${escapeHtml(address)}</a></p>` : ''}
${course.details.phone ? `<p><a href="tel:${escapeHtml(course.details.phone.replace(/[^\d+]/g, ''))}">${escapeHtml(course.details.phone)}</a></p>` : ''}
${websiteUrl ? `<p><a href="${escapeHtml(websiteUrl)}" rel="nofollow noopener">${escapeHtml(website)}</a></p>` : ''}
${course.details.notes?.trim() ? `<h2>Info to know</h2><div class="notes">${escapeHtml(course.details.notes.trim())}</div>` : ''}
${extraLayouts.length ? `<h2>${escapeHtml(course.layoutName || 'Main')} layout</h2>` : ''}
${layoutTable(course.layouts)}
${extraLayouts.map((layout) => `<h2>${escapeHtml(layout.name)} layout</h2><p class="meta">${escapeHtml(layoutStats(layout))}</p>${layoutTable(layout.layouts)}`).join('')}`);
};
