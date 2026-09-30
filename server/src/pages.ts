// Server-rendered website pages. The full content is in the HTML (for link previews and
// no-JS readers); the browser scripts add the satellite maps from the embedded page data.

type Point = { latitude: number; longitude: number; altitude?: number | null };
type Layout = { tee: Point | null; basket: Point | null; par?: number };
type PageShot = { hole: number; feet: number; disc?: string; type?: string; lie?: string; quality?: number; qualityMax?: number; latitude?: number; longitude?: number };
type PageLayout = { name: string; holes: number; layouts: Layout[]; par: number | null; mappedHoles: number; distanceFeet: number };

export const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

// Embedded JSON must not be able to close its <script> tag. The data is read with JSON.parse,
// never run as script, so replacing '<' with its six-character JSON escape (backslash u003c) is enough.
const LESS_THAN_JSON_ESCAPE = `${String.fromCharCode(92)}u003c`;
const embedJson = (data: unknown) => JSON.stringify(data).replace(/</g, LESS_THAN_JSON_ESCAPE);

const formatToPar = (diff: number) => (diff === 0 ? 'E' : diff > 0 ? `+${diff}` : String(diff));
const diffClass = (diff: number) => (diff < 0 ? 'under' : diff > 0 ? 'over' : '');

// Matches the app: an out-of-bounds throw adds a penalty stroke.
const strokes = (shots: PageShot[]) => shots.length + shots.filter((shot) => shot.lie === 'OB').length;

const EARTH_RADIUS_FEET = 20_902_231;
const feetBetween = (a: Point, b: Point) => {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * EARTH_RADIUS_FEET * Math.asin(Math.sqrt(h));
};

const throwDetail = (shot: PageShot) => [
  shot.feet ? `${shot.feet} ft` : null,
  [shot.disc || 'No disc', shot.type?.toLowerCase()].filter(Boolean).join(' '),
  shot.lie === 'OB' ? 'OB (+1)' : shot.lie?.toLowerCase(),
  shot.quality ? `${shot.quality}/${shot.qualityMax ?? 5}` : null,
].filter(Boolean).join(' · ');

type ShellOptions = {
  title: string;
  description: string;
  body: string;
  nav?: 'courses' | 'account';
  script?: string;
  data?: unknown;
  maps?: boolean;
};

export const renderShell = ({ title, description, body, nav, script, data, maps }: ShellOptions) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:site_name" content="Glide Path">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${maps ? '<link rel="stylesheet" href="/vendor/leaflet/leaflet.css">\n' : ''}<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="site-header"><div class="wrap">
  <a class="brand" href="/"><span class="brand-mark">G</span><span class="brand-name">GLIDE PATH</span></a>
  <nav class="site-nav"><a href="/"${nav === 'courses' ? ' aria-current="page"' : ''}>Courses</a><a href="/account"${nav === 'account' ? ' aria-current="page"' : ''}>My rounds</a></nav>
</div></header>
<main class="wrap">${body}</main>
<footer class="site-footer"><div class="wrap"><span>Glide Path · disc golf course mapping and round logging</span><a href="/privacy">Privacy</a></div></footer>
${data === undefined ? '' : `<script type="application/json" id="page-data">${embedJson(data)}</script>\n`}${maps ? '<script src="/vendor/leaflet/leaflet.js"></script>\n' : ''}${script ? `<script type="module" src="${script}"></script>\n` : ''}</body>
</html>`;

export const renderNotFoundPage = (what: string) => renderShell({
  title: 'Not found · Glide Path',
  description: `This ${what} doesn't exist or is no longer shared.`,
  body: `<h1>Not found</h1><p class="meta">This ${escapeHtml(what)} doesn't exist or is no longer shared.</p><p><a href="/">Search courses</a></p>`,
});

const layoutStats = (layout: Omit<PageLayout, 'name' | 'layouts'>) => [
  `${layout.holes} ${layout.holes === 1 ? 'hole' : 'holes'}`,
  layout.par === null ? null : `Par ${layout.par}`,
  layout.mappedHoles ? `${layout.distanceFeet.toLocaleString('en-US')} ft` : null,
].filter(Boolean).join(' · ');

const holeTable = (layouts: Layout[]) => `<table>
  <thead><tr><th>HOLE</th><th>PAR</th><th>DISTANCE</th><th>ELEVATION</th></tr></thead>
  <tbody>${layouts.map((layout, index) => {
    const distance = layout.tee && layout.basket ? `${Math.round(feetBetween(layout.tee, layout.basket))} ft` : '—';
    const rise = typeof layout.tee?.altitude === 'number' && typeof layout.basket?.altitude === 'number'
      ? Math.round((layout.basket.altitude - layout.tee.altitude) / 0.3048) : null;
    const elevation = rise === null ? '—' : rise > 0 ? `↑ ${rise} ft` : rise < 0 ? `↓ ${-rise} ft` : 'Flat';
    return `<tr data-hole="${index + 1}"><td>${String(index + 1).padStart(2, '0')}</td><td>${layout.par ?? '—'}</td><td>${distance}</td><td>${elevation}</td></tr>`;
  }).join('')}</tbody>
</table>`;

export const renderCoursePage = (course: {
  uid: string; name: string; holes: number; layouts: Layout[]; details: Record<string, string | undefined>; mappedBy: string;
  mappedHoles: number; par: number | null; distanceFeet: number; layoutName?: string; extraLayouts?: PageLayout[];
}) => {
  const street = course.details.street ?? course.details.address;
  const address = [street, course.details.city, course.details.state].map((part) => part?.trim()).filter(Boolean).join(', ');
  const website = course.details.website?.trim();
  const websiteUrl = website && (/^https?:\/\//i.test(website) ? website : `https://${website}`);
  const phone = course.details.phone?.trim();
  const layouts: PageLayout[] = [
    { name: course.layoutName || 'Main', holes: course.holes, layouts: course.layouts, par: course.par, mappedHoles: course.mappedHoles, distanceFeet: course.distanceFeet },
    ...(course.extraLayouts ?? []),
  ];
  const place = [course.details.city, course.details.state].map((part) => part?.trim()).filter(Boolean).join(', ');
  const body = `
<div class="eyebrow">Course${place ? ` · ${escapeHtml(place)}` : ''}</div>
<h1>${escapeHtml(course.name)}</h1>
<p class="meta">${escapeHtml(layoutStats(course))} · mapped by ${escapeHtml(course.mappedBy)}</p>
${address || phone || websiteUrl ? `<div class="links">
  ${address ? `<a class="button secondary" href="https://maps.apple.com/?q=${encodeURIComponent(address)}">Apple Maps</a><a class="button secondary" href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(address)}">Google Maps</a>` : ''}
  ${phone ? `<a class="button secondary" href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ''))}">Call ${escapeHtml(phone)}</a>` : ''}
  ${websiteUrl ? `<a class="button secondary" href="${escapeHtml(websiteUrl)}" rel="nofollow noopener">Website</a>` : ''}
</div>` : ''}
${address ? `<p class="meta">${escapeHtml(address)}</p>` : ''}
${layouts.length > 1 ? `<div class="tabs" role="group" aria-label="Layouts">${layouts.map((layout, index) => `<button type="button" data-layout="${index}" aria-pressed="${index === 0}">${escapeHtml(layout.name)}</button>`).join('')}</div>` : ''}
<div id="map" class="map tall" role="img" aria-label="Satellite map of the course's tees and baskets"></div>
<p class="map-note">Green dots are tees, orange dots are baskets. Tap a hole in the table to zoom to it.</p>
${layouts.map((layout, index) => `<section data-layout-panel="${index}"${index ? ' hidden' : ''}>
  ${layouts.length > 1 ? `<h2>${escapeHtml(layout.name)} layout</h2><p class="meta">${escapeHtml(layoutStats(layout))}</p>` : ''}
  ${holeTable(layout.layouts)}
</section>`).join('')}
${course.details.notes?.trim() ? `<h2>Info to know</h2><div class="card notes">${escapeHtml(course.details.notes.trim())}</div>` : ''}
<p class="meta">Play this course in the Glide Path app: search for it under Find courses and add it to your courses.</p>`;
  return renderShell({
    title: `${course.name} · Glide Path`,
    description: [layoutStats(course), place, `mapped by ${course.mappedBy}`].filter(Boolean).join(' · '),
    body,
    nav: 'courses',
    maps: true,
    script: '/js/course.js',
    data: { layouts: layouts.map((layout) => layout.layouts) },
  });
};

export const renderRoundPage = (round: {
  courseName: string; mode: string; shots: PageShot[]; playedBy: string; updatedAt: number; layouts: Layout[];
  courseUid: string | null; layoutName?: string | null;
}) => {
  const holes = [...new Set(round.shots.map((shot) => shot.hole))].sort((a, b) => a - b).map((hole) => {
    const holeShots = round.shots.filter((shot) => shot.hole === hole);
    return { hole, shots: holeShots, score: strokes(holeShots), par: round.layouts[hole - 1]?.par };
  });
  const withPar = holes.filter((item) => item.par !== undefined);
  const total = strokes(round.shots);
  const toPar = withPar.length ? withPar.reduce((sum, item) => sum + item.score - item.par!, 0) : null;
  const parTotal = withPar.reduce((sum, item) => sum + item.par!, 0);
  const courseName = round.courseUid ? `<a href="/c/${escapeHtml(round.courseUid)}">${escapeHtml(round.courseName)}</a>` : escapeHtml(round.courseName);
  const played = new Date(round.updatedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const scoreText = `${total}${toPar === null ? '' : ` (${formatToPar(toPar)})`}`;
  const body = `
<div class="eyebrow">${escapeHtml(round.mode === 'Practice' ? 'Practice session' : 'Round')} by ${escapeHtml(round.playedBy)}</div>
<h1>${courseName}</h1>
<p class="meta">${escapeHtml(played)}${round.layoutName ? ` · ${escapeHtml(round.layoutName)} layout` : ''} · ${holes.length} ${holes.length === 1 ? 'hole' : 'holes'}</p>
<div class="score"><span class="total">${total}</span>${toPar === null ? '' : `<span class="par ${diffClass(toPar)}">${formatToPar(toPar)}</span>`}</div>
<div id="map" class="map" role="img" aria-label="Satellite map of the selected hole and its throws"></div>
<p class="map-note">Tap a hole in the scorecard to see where each throw landed.</p>
<table>
  <thead><tr><th>HOLE</th><th>PAR</th><th>SCORE</th><th>+/−</th></tr></thead>
  <tbody>${holes.map((item) => {
    const diff = item.par === undefined ? null : item.score - item.par;
    return `<tr data-hole="${item.hole}"><td>${String(item.hole).padStart(2, '0')}</td><td>${item.par ?? '—'}</td><td><strong>${item.score}</strong></td><td class="${diff === null ? '' : diffClass(diff)}">${diff === null ? '—' : formatToPar(diff)}</td></tr>`;
  }).join('')}</tbody>
  <tfoot><tr><td>TOTAL</td><td>${withPar.length ? parTotal : '—'}</td><td>${total}</td><td class="${toPar === null ? '' : diffClass(toPar)}">${toPar === null ? '—' : formatToPar(toPar)}</td></tr></tfoot>
</table>
<div id="round-summary"></div>
<h2>Throw by throw</h2>
${holes.map((item) => `<h3>Hole ${String(item.hole).padStart(2, '0')}</h3><ol class="throws">${item.shots.map((shot) => `<li>${escapeHtml(throwDetail(shot))}</li>`).join('')}</ol>`).join('')}`;
  return renderShell({
    title: `${round.playedBy} at ${round.courseName} · Glide Path`,
    description: `Scored ${scoreText} on ${played}${round.layoutName ? ` (${round.layoutName} layout)` : ''}.`,
    body,
    maps: true,
    script: '/js/round.js',
    data: { shots: round.shots, layouts: round.layouts },
  });
};
