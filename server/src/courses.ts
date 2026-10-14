// A course for its editor on the website (an owner, or a site admin), and saves from it. Saves
// merge with phones' edits the same way sync does (see saveCourseEdit).
import { AccessError, canEditCourse, grantAccess, isSiteAdmin, roleOn } from './access.ts';
import type { CourseRecord } from './contract.ts';
import type { Queryable } from './db.ts';
import { courseFromRow, saveCourseEdit, SHARED_COURSE_PREFIX, writeCourse } from './sync.ts';

type Row = Parameters<typeof courseFromRow>[0] & { created_by: string };

const load = async (db: Queryable, uid: string, lock = false) => {
  const { rows } = await db.query<Row>(
    `SELECT c.*, u.display_name AS created_by FROM courses c JOIN users u ON u.id = c.owner_id
     WHERE c.uid = $1 AND NOT c.deleted${lock ? ' FOR UPDATE OF c' : ''}`,
    [uid],
  );
  if (!rows[0]) throw new AccessError(404, 'Course not found.');
  return rows[0];
};

// The course as the editor shows it, and what this account can do with it.
export const courseForEditor = async (db: Queryable, uid: string, userId: string) => {
  const row = await load(db, uid);
  const { clientId: _clientId, deleted: _deleted, ...course } = courseFromRow(row);
  return {
    course: { ...course, uid, createdBy: row.created_by },
    role: await roleOn(db, uid, userId),
    canEdit: await canEditCourse(db, uid, userId),
    isAdmin: await isSiteAdmin(db, userId),
  };
};

export type CourseEdit = Pick<CourseRecord, 'name' | 'holes' | 'layouts' | 'layoutName' | 'extraLayouts' | 'details'>;

// Saves an owner's or site admin's edit. `baseUpdatedAt` is the version they edited: a phone's
// newer save is merged in rather than overwritten.
export const saveCourse = async (tx: Queryable, uid: string, userId: string, edit: CourseEdit, baseUpdatedAt: number, now: number) => {
  if (!(await canEditCourse(tx, uid, userId))) throw new AccessError(404, 'Course not found.');
  const row = await load(tx, uid, true);
  const stored = courseFromRow(row);
  await saveCourseEdit(tx, row.owner_id, stored, { ...stored, ...edit, published: true, updatedAt: Math.max(now, stored.updatedAt + 1) }, baseUpdatedAt);
  return courseForEditor(tx, uid, userId);
};

// Deletes a course for everyone (an owner or site admin).
export const deleteCourse = async (tx: Queryable, uid: string, userId: string, now: number) => {
  if (!(await canEditCourse(tx, uid, userId))) throw new AccessError(404, 'Course not found.');
  const row = await load(tx, uid, true);
  const stored = courseFromRow(row);
  await writeCourse(tx, row.owner_id, { ...stored, deleted: true, updatedAt: Math.max(now, stored.updatedAt + 1) });
};

const MAIN_LAYOUT_ID = 'main';

// Moves layout `layoutId` of course `sourceUid` into course `targetUid`, for someone who can edit
// both: added as a new layout, or (with `replaceLayoutId`) in place of one of target's, keeping
// that layout's name. Its holes, tees, baskets and pars go across, and so do the rounds played on
// it (their players get target in their list). It's then removed from source, unless it's
// source's main layout, which a course can't be without: that one is copied. Returns the target
// as the editor shows it.
export const moveLayout = async (tx: Queryable, targetUid: string, userId: string, move: { sourceUid: string; layoutId: string; replaceLayoutId?: string }, now: number) => {
  const { sourceUid, layoutId, replaceLayoutId } = move;
  if (sourceUid === targetUid) throw new AccessError(400, 'Pick a layout from another course.');
  if (!(await canEditCourse(tx, targetUid, userId)) || !(await canEditCourse(tx, sourceUid, userId))) {
    throw new AccessError(403, 'You can only move a layout between courses you can edit.');
  }
  const targetRow = await load(tx, targetUid, true);
  const sourceRow = await load(tx, sourceUid, true);
  const target = courseFromRow(targetRow);
  const source = courseFromRow(sourceRow);
  const moving = layoutId === MAIN_LAYOUT_ID
    ? { id: MAIN_LAYOUT_ID, name: source.layoutName || 'Main', holes: source.holes, layouts: source.layouts }
    : source.extraLayouts.find((layout) => layout.id === layoutId);
  if (!moving) throw new AccessError(404, 'That layout isn’t on the course any more.');

  // Into target: in place of one of its layouts, or as a new one (named apart from the others).
  let newLayoutId: string;
  let edited: typeof target;
  if (replaceLayoutId === MAIN_LAYOUT_ID) {
    newLayoutId = MAIN_LAYOUT_ID;
    edited = { ...target, holes: moving.layouts.length, layouts: moving.layouts };
  } else if (replaceLayoutId) {
    if (!target.extraLayouts.some((layout) => layout.id === replaceLayoutId)) throw new AccessError(404, 'That layout isn’t on this course any more.');
    newLayoutId = replaceLayoutId;
    edited = { ...target, extraLayouts: target.extraLayouts.map((layout) => (layout.id === replaceLayoutId ? { ...layout, holes: moving.layouts.length, layouts: moving.layouts } : layout)) };
  } else {
    const taken = (id: string) => id === MAIN_LAYOUT_ID || target.extraLayouts.some((layout) => layout.id === id);
    newLayoutId = taken(moving.id) ? `layout-${now}` : moving.id;
    const names = [target.layoutName || 'Main', ...target.extraLayouts.map((layout) => layout.name)].map((name) => name.trim().toLowerCase());
    const name = names.includes(moving.name.trim().toLowerCase()) ? `${moving.name} (moved)` : moving.name;
    edited = { ...target, extraLayouts: [...target.extraLayouts, { id: newLayoutId, name, holes: moving.layouts.length, layouts: moving.layouts }] };
  }
  await writeCourse(tx, targetRow.owner_id, { ...edited, published: true, updatedAt: Math.max(now, target.updatedAt + 1) });

  // Rounds played on it follow, to the new layout, under target's id as each player knows it.
  const { rows: moved } = await tx.query<{ owner_id: string }>(
    `UPDATE rounds SET
       course_client_id = CASE WHEN owner_id = $5 THEN $6 ELSE '${SHARED_COURSE_PREFIX}' || $7 END,
       layout_id = $8, course_name = $9,
       updated_at = GREATEST(updated_at + 1, $10), version = nextval('sync_version')
     WHERE NOT deleted AND ((owner_id = $1 AND course_client_id = $2) OR course_client_id = '${SHARED_COURSE_PREFIX}' || $3)
       AND COALESCE(layout_id, '${MAIN_LAYOUT_ID}') = $4
     RETURNING owner_id`,
    [sourceRow.owner_id, sourceRow.client_id, sourceUid, layoutId, targetRow.owner_id, targetRow.client_id, targetUid,
      newLayoutId === MAIN_LAYOUT_ID ? null : newLayoutId, target.name, now],
  );
  for (const player of new Set(moved.map((row) => row.owner_id))) {
    if (player !== targetRow.owner_id) await grantAccess(tx, targetUid, player, 'player', now);
  }

  // Out of source, unless it's source's main layout.
  if (layoutId !== MAIN_LAYOUT_ID) {
    await writeCourse(tx, sourceRow.owner_id, {
      ...source, extraLayouts: source.extraLayouts.filter((layout) => layout.id !== layoutId), updatedAt: Math.max(now, source.updatedAt + 1),
    });
  }
  return { ...(await courseForEditor(tx, targetUid, userId)), movedRounds: moved.length, layoutId: newLayoutId };
};
