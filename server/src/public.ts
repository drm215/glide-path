import type { Queryable } from './db.ts';

type Layout = { tee: { latitude: number; longitude: number } | null; basket: { latitude: number; longitude: number } | null; par?: number };
type ExtraLayout = { id: string; name: string; holes: number; layouts: Layout[] };

const MAIN_LAYOUT_ID = 'main';

const EARTH_RADIUS_FEET = 20_902_231;

export const feetBetween = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_FEET * Math.asin(Math.sqrt(h));
};

// Mirrors the app's course stats so the website and app agree.
export const courseTotals = (layouts: Layout[]) => {
  const mapped = layouts.filter((layout) => layout.tee && layout.basket);
  const pars = layouts.flatMap((layout) => (layout.par === undefined ? [] : [layout.par]));
  return {
    mappedHoles: mapped.length,
    par: pars.length ? pars.reduce((sum, par) => sum + par, 0) : null,
    parHoles: pars.length,
    distanceFeet: Math.round(mapped.reduce((sum, layout) => sum + feetBetween(layout.tee!, layout.basket!), 0)),
  };
};

type PublicCourseRow = {
  uid: string; name: string; hole_count: number; city: string | null; state: string | null; latitude: number | null;
  longitude: number | null; layouts: Layout[]; details: Record<string, string | undefined>; display_name: string; distance_miles?: number | null;
  layout_name: string | null; extra_layouts: ExtraLayout[]; updated_at?: string;
};

export type CourseSearch = { query?: string; near?: { latitude: number; longitude: number }; limit: number };

export const searchPublishedCourses = async (db: Queryable, search: CourseSearch) => {
  const params: unknown[] = [];
  const where = ['c.published', 'NOT c.deleted'];
  if (search.query) {
    params.push(`%${search.query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
    where.push(`(c.name ILIKE $${params.length} OR c.city ILIKE $${params.length} OR c.state ILIKE $${params.length})`);
  }
  let distance = 'NULL::double precision';
  let order = 'c.name';
  if (search.near) {
    params.push(search.near.latitude, search.near.longitude);
    const lat = `$${params.length - 1}`;
    const lng = `$${params.length}`;
    // Haversine distance in miles from the search point to the course's first tee.
    distance = `3958.8 * 2 * asin(sqrt(power(sin(radians(c.latitude - ${lat}) / 2), 2) + cos(radians(${lat})) * cos(radians(c.latitude)) * power(sin(radians(c.longitude - ${lng}) / 2), 2)))`;
    order = 'distance_miles NULLS LAST, c.name';
  }
  params.push(search.limit);
  const { rows } = await db.query<PublicCourseRow>(
    `SELECT c.uid, c.name, c.hole_count, c.city, c.state, c.latitude, c.longitude, c.layouts, c.details, u.display_name,
            c.layout_name, c.extra_layouts, ${distance} AS distance_miles
     FROM courses c JOIN users u ON u.id = c.owner_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${order}
     LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    uid: row.uid,
    name: row.name,
    holes: row.hole_count,
    city: row.city,
    state: row.state,
    latitude: row.latitude,
    longitude: row.longitude,
    mappedBy: row.display_name,
    distanceMiles: row.distance_miles == null ? null : Math.round(row.distance_miles * 10) / 10,
    layoutCount: 1 + row.extra_layouts.length,
    ...courseTotals(row.layouts),
  }));
};

export const getPublishedCourse = async (db: Queryable, uid: string) => {
  const { rows } = await db.query<PublicCourseRow>(
    `SELECT c.uid, c.name, c.hole_count, c.city, c.state, c.latitude, c.longitude, c.layouts, c.details, u.display_name,
            c.layout_name, c.extra_layouts, c.updated_at
     FROM courses c JOIN users u ON u.id = c.owner_id
     WHERE c.uid = $1 AND c.published AND NOT c.deleted`,
    [uid],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    uid: row.uid,
    name: row.name,
    holes: row.hole_count,
    layouts: row.layouts,
    layoutName: row.layout_name ?? undefined,
    extraLayouts: row.extra_layouts.map((layout) => ({ ...layout, ...courseTotals(layout.layouts) })),
    details: row.details,
    mappedBy: row.display_name,
    // The publisher's last edit; copies in the app compare it to know when to update.
    updatedAt: Number(row.updated_at),
    ...courseTotals(row.layouts),
  };
};

type SharedRoundRow = {
  course_name: string; mode: string; shots: unknown[]; updated_at: string; display_name: string; layout_id: string | null; pars: (number | null)[] | null;
  layouts: Layout[] | null; hole_count: number | null; course_uid: string | null; course_published: boolean | null;
  layout_name: string | null; extra_layouts: ExtraLayout[] | null;
};

// Matches roundLayouts in public/js/round-stats.js: a round's saved pars replace the course's.
const withRoundPars = (layouts: Layout[], pars: (number | null)[] | null): Layout[] => (pars?.length
  ? Array.from({ length: Math.max(layouts.length, pars.length) }, (_, index) => {
    const par = pars[index];
    const layout = layouts[index] ?? { tee: null, basket: null };
    return par === null || par === undefined ? layout : { ...layout, par };
  })
  : layouts);

export const getSharedRound = async (db: Queryable, shareToken: string) => {
  const { rows } = await db.query<SharedRoundRow>(
    `SELECT r.course_name, r.mode, r.shots, r.updated_at, r.layout_id, r.pars, u.display_name,
            c.layouts, c.hole_count, c.uid AS course_uid, c.published AS course_published, c.layout_name, c.extra_layouts
     FROM rounds r
     JOIN users u ON u.id = r.owner_id
     -- The course it was played on: the player's own, or one shared with them (as shared-<uid>).
     LEFT JOIN courses c ON NOT c.deleted AND ((c.owner_id = r.owner_id AND c.client_id = r.course_client_id)
       OR r.course_client_id = 'shared-' || c.uid)
     WHERE r.share_token = $1 AND r.shared AND NOT r.deleted`,
    [shareToken],
  );
  const row = rows[0];
  if (!row) return null;
  // The layout the round was played on; a layout deleted since then has no pars to show.
  const extra = row.layout_id && row.layout_id !== MAIN_LAYOUT_ID ? row.extra_layouts?.find((layout) => layout.id === row.layout_id) : undefined;
  const layoutMissing = Boolean(row.layout_id && row.layout_id !== MAIN_LAYOUT_ID && !extra);
  return {
    courseName: row.course_name,
    mode: row.mode,
    shots: row.shots,
    playedBy: row.display_name,
    updatedAt: Number(row.updated_at),
    layoutName: extra ? extra.name : row.extra_layouts?.length ? (row.layout_name || 'Main') : null,
    // Sharing a round shares the hole layouts it was played on, so its map and pars can be shown,
    // with the pars it was played with in place of the course's current ones.
    layouts: withRoundPars(layoutMissing ? [] : extra ? extra.layouts : row.layouts ?? [], row.pars),
    courseUid: row.course_published ? row.course_uid : null,
  };
};
