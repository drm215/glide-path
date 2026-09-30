import { randomBytes } from 'node:crypto';
import type { Queryable } from './db.ts';
import type { BagRecord, CourseRecord, RoundRecord } from './contract.ts';

export const newShareToken = () => randomBytes(12).toString('base64url');

type CourseRow = {
  uid: string; client_id: string; name: string; hole_count: number; details: CourseRecord['details'];
  layouts: CourseRecord['layouts']; published: boolean; updated_at: string; deleted: boolean; version: string;
  layout_name: string | null; extra_layouts: CourseRecord['extraLayouts'];
};
type RoundRow = {
  uid: string; client_id: string; course_client_id: string | null; course_name: string; mode: RoundRecord['mode'];
  shots: RoundRecord['shots']; shared: boolean; share_token: string | null; updated_at: string; deleted: boolean; version: string;
  layout_id: string | null;
};
type BagRow = { discs: string[]; details: BagRecord['details']; weights: BagRecord['weights']; updated_at: string; version: string };

// Used to place a course on the map and sort by distance: its first tee, or failing that its first basket.
const coursePosition = (course: CourseRecord) => {
  const point = course.layouts.find((layout) => layout.tee)?.tee ?? course.layouts.find((layout) => layout.basket)?.basket;
  return point ? { latitude: point.latitude, longitude: point.longitude } : { latitude: null, longitude: null };
};

// Each upsert only replaces the stored row when the incoming edit is newer (last write wins).
const upsertCourse = (tx: Queryable, ownerId: string, course: CourseRecord) => {
  const position = coursePosition(course);
  return tx.query(
    `INSERT INTO courses (owner_id, client_id, name, hole_count, details, layouts, published, city, state, latitude, longitude, updated_at, deleted, layout_name, extra_layouts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (owner_id, client_id) DO UPDATE SET
       name = EXCLUDED.name, hole_count = EXCLUDED.hole_count, details = EXCLUDED.details, layouts = EXCLUDED.layouts,
       layout_name = EXCLUDED.layout_name, extra_layouts = EXCLUDED.extra_layouts,
       published = EXCLUDED.published, city = EXCLUDED.city, state = EXCLUDED.state, latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude, updated_at = EXCLUDED.updated_at, deleted = EXCLUDED.deleted, version = nextval('sync_version')
     WHERE courses.updated_at < EXCLUDED.updated_at`,
    [
      ownerId, course.clientId, course.name, course.holes, JSON.stringify(course.details), JSON.stringify(course.layouts),
      course.published && !course.deleted, course.details.city?.trim() || null, course.details.state?.trim().toUpperCase() || null,
      position.latitude, position.longitude, course.updatedAt, course.deleted ?? false,
      course.layoutName ?? null, JSON.stringify(course.extraLayouts),
    ],
  );
};

const upsertRound = (tx: Queryable, ownerId: string, round: RoundRecord) =>
  tx.query(
    `INSERT INTO rounds (owner_id, client_id, course_client_id, course_name, mode, shots, shared, share_token, updated_at, deleted, layout_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 THEN $8 END, $9, $10, $11)
     ON CONFLICT (owner_id, client_id) DO UPDATE SET
       course_client_id = EXCLUDED.course_client_id, layout_id = EXCLUDED.layout_id, course_name = EXCLUDED.course_name, mode = EXCLUDED.mode, shots = EXCLUDED.shots,
       shared = EXCLUDED.shared, share_token = CASE WHEN EXCLUDED.shared THEN COALESCE(rounds.share_token, $8) END,
       updated_at = EXCLUDED.updated_at, deleted = EXCLUDED.deleted, version = nextval('sync_version')
     WHERE rounds.updated_at < EXCLUDED.updated_at`,
    [
      ownerId, round.clientId, round.courseClientId ?? null, round.courseName, round.mode, JSON.stringify(round.shots),
      round.shared && !round.deleted, newShareToken(), round.updatedAt, round.deleted ?? false, round.layoutId ?? null,
    ],
  );

const upsertBag = (tx: Queryable, ownerId: string, bag: BagRecord) =>
  tx.query(
    `INSERT INTO bags (owner_id, discs, details, weights, updated_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (owner_id) DO UPDATE SET discs = EXCLUDED.discs, details = EXCLUDED.details, weights = EXCLUDED.weights,
       updated_at = EXCLUDED.updated_at, version = nextval('sync_version')
     WHERE bags.updated_at < EXCLUDED.updated_at`,
    [ownerId, JSON.stringify(bag.discs), JSON.stringify(bag.details), JSON.stringify(bag.weights), bag.updatedAt],
  );

export type SyncInput = { cursor: number; courses: CourseRecord[]; rounds: RoundRecord[]; bag?: BagRecord };

export const runSync = async (tx: Queryable, ownerId: string, input: SyncInput) => {
  for (const course of input.courses) await upsertCourse(tx, ownerId, course);
  for (const round of input.rounds) await upsertRound(tx, ownerId, round);
  if (input.bag) await upsertBag(tx, ownerId, input.bag);

  const [courses, rounds, bags] = await Promise.all([
    tx.query<CourseRow>('SELECT * FROM courses WHERE owner_id = $1 AND version > $2 ORDER BY version', [ownerId, input.cursor]),
    tx.query<RoundRow>('SELECT * FROM rounds WHERE owner_id = $1 AND version > $2 ORDER BY version', [ownerId, input.cursor]),
    tx.query<BagRow>('SELECT * FROM bags WHERE owner_id = $1 AND version > $2', [ownerId, input.cursor]),
  ]);
  const versions = [...courses.rows, ...rounds.rows, ...bags.rows].map((row) => Number(row.version));

  return {
    cursor: Math.max(input.cursor, ...versions),
    courses: courses.rows.map((row) => ({
      uid: row.uid,
      clientId: row.client_id,
      updatedAt: Number(row.updated_at),
      deleted: row.deleted,
      name: row.name,
      holes: row.hole_count,
      layouts: row.layouts,
      layoutName: row.layout_name ?? undefined,
      extraLayouts: row.extra_layouts,
      details: row.details,
      published: row.published,
    })),
    rounds: rounds.rows.map((row) => ({
      uid: row.uid,
      clientId: row.client_id,
      updatedAt: Number(row.updated_at),
      deleted: row.deleted,
      courseClientId: row.course_client_id ?? undefined,
      courseName: row.course_name,
      mode: row.mode,
      shots: row.shots,
      shared: row.shared,
      shareToken: row.share_token,
      layoutId: row.layout_id ?? undefined,
    })),
    bag: bags.rows[0] ? { updatedAt: Number(bags.rows[0].updated_at), discs: bags.rows[0].discs, details: bags.rows[0].details, weights: bags.rows[0].weights } : null,
  };
};
