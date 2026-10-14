// A course for its editor on the website (an owner, or a site admin), and saves from it. Saves
// merge with phones' edits the same way sync does (see saveCourseEdit).
import { AccessError, canEditCourse, isSiteAdmin, roleOn } from './access.ts';
import type { CourseRecord } from './contract.ts';
import type { Queryable } from './db.ts';
import { courseFromRow, saveCourseEdit, writeCourse } from './sync.ts';

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
