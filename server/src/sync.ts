import { randomBytes } from 'node:crypto';
import type { Queryable } from './db.ts';
import type { BagRecord, CourseRecord, RoundRecord } from './contract.ts';
import { canEdit, grantAccess, type Role } from './access.ts';
import { mergeCourseRecords, sameCourse } from './course-merge.ts';

export const newShareToken = () => randomBytes(12).toString('base64url');

type CourseRow = {
  uid: string; client_id: string; name: string; hole_count: number; details: CourseRecord['details'];
  layouts: CourseRecord['layouts']; published: boolean; updated_at: string; deleted: boolean; version: string;
  layout_name: string | null; extra_layouts: CourseRecord['extraLayouts']; owner_id: string;
  // In sync responses: this account's role on it, and (if someone else created it) their name.
  role?: Role | null; created_by?: string | null;
};

// A course someone else created reaches an account as `shared-<uid>`: its own id there, which
// can't clash with the ids of courses it created. Its edits and rounds come back under that id.
export const SHARED_COURSE_PREFIX = 'shared-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RoundRow = {
  uid: string; client_id: string; course_client_id: string | null; course_name: string; mode: RoundRecord['mode'];
  shots: RoundRecord['shots']; shared: boolean; share_token: string | null; updated_at: string; deleted: boolean; version: string;
  layout_id: string | null; in_progress: boolean; pars: (number | null)[] | null;
};
type BagRow = { discs: string[]; details: BagRecord['details']; weights: BagRecord['weights']; updated_at: string; version: string };

// Used to place a course on the map and sort by distance: its first tee, or failing that its first basket.
const coursePosition = (course: CourseRecord) => {
  const point = course.layouts.find((layout) => layout.tee)?.tee ?? course.layouts.find((layout) => layout.basket)?.basket;
  return point ? { latitude: point.latitude, longitude: point.longitude } : { latitude: null, longitude: null };
};

// The stored course as a sync record, for merging.
const courseFromRow = (row: CourseRow): CourseRecord => ({
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
});

const upsertCourse = async (tx: Queryable, userId: string, record: CourseRecord, now: number) => {
  if (record.clientId.startsWith(SHARED_COURSE_PREFIX)) return upsertSharedCourse(tx, userId, record);
  const { baseUpdatedAt, sourceUid, ...incoming } = record;
  if (sourceUid && !incoming.deleted && (await mergeCopyIntoSource(tx, userId, sourceUid, incoming, now))) return;
  const { rows } = await tx.query<CourseRow>('SELECT * FROM courses WHERE owner_id = $1 AND client_id = $2 FOR UPDATE', [userId, incoming.clientId]);
  if (!rows[0]) return writeCourse(tx, userId, incoming);
  return saveCourseEdit(tx, userId, courseFromRow(rows[0]), incoming, baseUpdatedAt);
};

// A course someone else created. Its owners and admins edit it like its creator does, and
// deleting it deletes it for everyone; a player's edits are ignored, and a player deleting it just
// stops playing it (it leaves their devices).
const upsertSharedCourse = async (tx: Queryable, userId: string, { baseUpdatedAt, sourceUid: _sourceUid, ...incoming }: CourseRecord) => {
  const uid = incoming.clientId.slice(SHARED_COURSE_PREFIX.length);
  if (!UUID.test(uid)) return;
  const { rows } = await tx.query<CourseRow>(
    `SELECT c.*, a.role FROM courses c JOIN course_access a ON a.course_uid = c.uid
     WHERE c.uid = $1 AND a.user_id = $2 AND NOT a.removed FOR UPDATE OF c`,
    [uid, userId],
  );
  const row = rows[0];
  if (!row || row.deleted) return;
  const stored = courseFromRow(row);
  if (incoming.deleted && !canEdit(row.role)) {
    await tx.query(`UPDATE course_access SET removed = true, updated_at = $3, version = nextval('sync_version') WHERE course_uid = $1 AND user_id = $2`, [uid, userId, incoming.updatedAt]);
    return;
  }
  if (!canEdit(row.role)) return;
  if (incoming.deleted) return writeCourse(tx, row.owner_id, { ...stored, deleted: true, updatedAt: Math.max(incoming.updatedAt, stored.updatedAt + 1) });
  return saveCourseEdit(tx, row.owner_id, stored, { ...incoming, clientId: stored.clientId }, baseUpdatedAt);
};

// A course copied from the directory by an app from before courses were shared goes back into the
// course it was copied from: its mapping is merged in (the original's own details and pars win),
// its rounds move to the original, the copy is deleted, and the account plays the original.
// Returns false (leaving the copy as its own course) when the original is gone.
const mergeCopyIntoSource = async (tx: Queryable, userId: string, sourceUid: string, copy: CourseRecord, now: number) => {
  if (!UUID.test(sourceUid)) return false;
  const { rows } = await tx.query<CourseRow>('SELECT * FROM courses WHERE uid = $1 AND NOT deleted FOR UPDATE', [sourceUid]);
  const source = rows[0];
  if (!source || (source.owner_id === userId && source.client_id === copy.clientId)) return false;
  const stored = courseFromRow(source);
  await saveCourseEdit(tx, source.owner_id, stored, { ...copy, clientId: stored.clientId, updatedAt: Math.min(copy.updatedAt, stored.updatedAt - 1) }, undefined);
  await writeCourse(tx, userId, { ...copy, deleted: true, updatedAt: Math.max(copy.updatedAt + 1, now) });
  // Rounds on the copy move to the original: those stored now, and (see upsertRound) any that
  // arrive later still naming the copy.
  const target = source.owner_id === userId ? source.client_id : `${SHARED_COURSE_PREFIX}${sourceUid}`;
  await tx.query('UPDATE courses SET merged_into = $3 WHERE owner_id = $1 AND client_id = $2', [userId, copy.clientId, target]);
  await tx.query(
    `UPDATE rounds SET course_client_id = $3, updated_at = GREATEST(updated_at + 1, $4), version = nextval('sync_version')
     WHERE owner_id = $1 AND course_client_id = $2`,
    [userId, copy.clientId, target, now],
  );
  if (source.owner_id !== userId) await grantAccess(tx, sourceUid, userId, 'player', now);
  return true;
};

// A course save made on top of the stored version replaces it; one made on top of an older
// version is merged with it (see course-merge.ts), so no device's mapping is lost. A result that
// differs from what the device sent is saved with an edit time past both, so every device takes
// it, the sender included.
const saveCourseEdit = async (tx: Queryable, ownerId: string, stored: CourseRecord, incoming: CourseRecord, baseUpdatedAt: number | undefined) => {
  if (baseUpdatedAt !== undefined && baseUpdatedAt >= stored.updatedAt) {
    // The device saw the stored version. Its save stands, even with a clock that runs behind.
    if (sameCourse(incoming, stored)) return;
    return writeCourse(tx, ownerId, { ...incoming, updatedAt: Math.max(incoming.updatedAt, stored.updatedAt + 1) });
  }
  const merged = mergeCourseRecords(stored, incoming);
  if (stored.updatedAt >= incoming.updatedAt && sameCourse(merged, stored)) return;
  const updatedAt = incoming.updatedAt > stored.updatedAt && sameCourse(merged, incoming)
    ? incoming.updatedAt
    : Math.max(stored.updatedAt, incoming.updatedAt) + 1;
  return writeCourse(tx, ownerId, { ...merged, updatedAt });
};

// Each write only replaces the stored row when its edit time is newer.
const writeCourse = (tx: Queryable, ownerId: string, course: CourseRecord) => {
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
      // Every course is public.
      !course.deleted, course.details.city?.trim() || null, course.details.state?.trim().toUpperCase() || null,
      position.latitude, position.longitude, course.updatedAt, course.deleted ?? false,
      course.layoutName ?? null, JSON.stringify(course.extraLayouts),
    ],
  );
};

const upsertRound = (tx: Queryable, ownerId: string, round: RoundRecord) =>
  tx.query(
    `INSERT INTO rounds (owner_id, client_id, course_client_id, course_name, mode, shots, shared, share_token, updated_at, deleted, layout_id, in_progress, pars)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 THEN $8 END, $9, $10, $11, $12, $13)
     ON CONFLICT (owner_id, client_id) DO UPDATE SET
       course_client_id = EXCLUDED.course_client_id, layout_id = EXCLUDED.layout_id, in_progress = EXCLUDED.in_progress, pars = EXCLUDED.pars,
       course_name = EXCLUDED.course_name, mode = EXCLUDED.mode, shots = EXCLUDED.shots,
       shared = EXCLUDED.shared, share_token = CASE WHEN EXCLUDED.shared THEN COALESCE(rounds.share_token, $8) END,
       updated_at = EXCLUDED.updated_at, deleted = EXCLUDED.deleted, version = nextval('sync_version')
     WHERE rounds.updated_at < EXCLUDED.updated_at`,
    [
      ownerId, round.clientId, round.courseClientId ?? null, round.courseName, round.mode, JSON.stringify(round.shots),
      round.shared && !round.deleted, newShareToken(), round.updatedAt, round.deleted ?? false, round.layoutId ?? null,
      round.inProgress ?? false, round.pars ? JSON.stringify(round.pars) : null,
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

const COURSE_COLUMNS = 'c.uid, c.name, c.hole_count, c.details, c.layouts, c.published, c.updated_at, c.deleted, c.layout_name, c.extra_layouts, c.owner_id';

// Most records sent back in one sync response; the client asks again while `more` is true.
// Kept modest because a round can hold thousands of throws.
export const SYNC_PAGE_SIZE = 200;

export type SyncInput = { cursor: number; courses: CourseRecord[]; rounds: RoundRecord[]; bag?: BagRecord };

export const runSync = async (tx: Queryable, ownerId: string, input: SyncInput) => {
  // One sync per user at a time. Versions are taken when rows are written but become visible at
  // commit, so two overlapping syncs could commit out of order; a client that saw the later
  // version would move its cursor past the earlier one and never receive it.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ownerId]);
  const now = Date.now();
  for (const course of input.courses) await upsertCourse(tx, ownerId, course, now);
  // A round still naming a copy that was merged into its original moves to the original, with an
  // edit time that makes the sender take the change.
  const { rows: mergedCopies } = await tx.query<{ client_id: string; merged_into: string }>(
    'SELECT client_id, merged_into FROM courses WHERE owner_id = $1 AND merged_into IS NOT NULL', [ownerId],
  );
  const movedTo = new Map(mergedCopies.map((row) => [row.client_id, row.merged_into]));
  for (const round of input.rounds) {
    const target = round.courseClientId ? movedTo.get(round.courseClientId) : undefined;
    await upsertRound(tx, ownerId, target ? { ...round, courseClientId: target, updatedAt: Math.max(round.updatedAt + 1, now) } : round);
  }
  if (input.bag) await upsertBag(tx, ownerId, input.bag);

  // Changes go back a page at a time, oldest first: the first SYNC_PAGE_SIZE across all three
  // tables. Each table is read one row past the page so `more` can tell whether anything is left.
  const [allCourses, allRounds, bags] = await Promise.all([
    // The courses it created; courses it plays or edits that someone else created (as
    // `shared-<uid>`, changed when the course or its access did); and, as deletions, courses it no
    // longer plays.
    tx.query<CourseRow>(
      `SELECT * FROM (
         SELECT ${COURSE_COLUMNS}, c.client_id, c.version, 'owner'::text AS role, NULL::text AS created_by
         FROM courses c WHERE c.owner_id = $1 AND c.version > $2
         UNION ALL
         SELECT ${COURSE_COLUMNS}, '${SHARED_COURSE_PREFIX}' || c.uid, GREATEST(c.version, a.version), a.role, u.display_name
         FROM course_access a JOIN courses c ON c.uid = a.course_uid JOIN users u ON u.id = c.owner_id
         WHERE a.user_id = $1 AND NOT a.removed AND GREATEST(c.version, a.version) > $2
         UNION ALL
         SELECT c.uid, c.name, c.hole_count, c.details, c.layouts, c.published, a.updated_at, true, c.layout_name, c.extra_layouts, c.owner_id,
                '${SHARED_COURSE_PREFIX}' || c.uid, a.version, NULL, NULL
         FROM course_access a JOIN courses c ON c.uid = a.course_uid
         WHERE a.user_id = $1 AND a.removed AND a.version > $2
       ) AS changed ORDER BY version LIMIT $3`,
      [ownerId, input.cursor, SYNC_PAGE_SIZE + 1],
    ),
    tx.query<RoundRow>('SELECT * FROM rounds WHERE owner_id = $1 AND version > $2 ORDER BY version LIMIT $3', [ownerId, input.cursor, SYNC_PAGE_SIZE + 1]),
    tx.query<BagRow>('SELECT * FROM bags WHERE owner_id = $1 AND version > $2', [ownerId, input.cursor]),
  ]);
  const versions = [...allCourses.rows, ...allRounds.rows, ...bags.rows].map((row) => Number(row.version)).sort((a, b) => a - b);
  const more = versions.length > SYNC_PAGE_SIZE;
  const cursor = more ? versions[SYNC_PAGE_SIZE - 1] : Math.max(input.cursor, ...versions);
  const inPage = (row: { version: string }) => Number(row.version) <= cursor;
  const courses = allCourses.rows.filter(inPage);
  const rounds = allRounds.rows.filter(inPage);
  const bag = bags.rows.find(inPage);

  return {
    cursor,
    more,
    courses: courses.map((row) => ({
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
      role: row.role ?? undefined,
      createdBy: row.created_by ?? undefined,
    })),
    rounds: rounds.map((row) => ({
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
      inProgress: row.in_progress,
      pars: row.pars ?? undefined,
    })),
    bag: bag ? { updatedAt: Number(bag.updated_at), discs: bag.discs, details: bag.details, weights: bag.weights } : null,
  };
};
