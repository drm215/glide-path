// Who can do what with a course. Every course is public: anyone signed in can find it and play
// it. Its owners (its creator, and anyone an owner adds) edit it, add and remove other owners, and
// delete it; an account can own any number of courses. Site admins (users.is_admin) can do all of
// that on every course, and manage accounts (see admin.ts). An account that plays a course it
// doesn't own has a player row, so its devices keep the course up to date (see sync.ts).
import type { Queryable } from './db.ts';

export type Role = 'owner' | 'player';
export const canEdit = (role: string | null | undefined) => role === 'owner';

export class AccessError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const isSiteAdmin = async (db: Queryable, userId: string) =>
  (await db.query<{ is_admin: boolean }>('SELECT is_admin FROM users WHERE id = $1', [userId])).rows[0]?.is_admin ?? false;

// `userId`'s own role on a live course: owner for its creator or an owner it was given; player if
// it plays it; null if neither. Site admins aren't owners, but edit like one (see canEditCourse).
export const roleOn = async (db: Queryable, uid: string, userId: string): Promise<Role | null> => {
  const { rows } = await db.query<{ owner_id: string; role: Role | null }>(
    `SELECT c.owner_id, a.role FROM courses c
     LEFT JOIN course_access a ON a.course_uid = c.uid AND a.user_id = $2 AND NOT a.removed
     WHERE c.uid = $1 AND NOT c.deleted`,
    [uid, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return row.owner_id === userId ? 'owner' : row.role;
};

// Whether `userId` can change a course: an owner of it, or a site admin.
export const canEditCourse = async (db: Queryable, uid: string, userId: string) =>
  canEdit(await roleOn(db, uid, userId)) || isSiteAdmin(db, userId);

const requireEditor = async (db: Queryable, uid: string, userId: string) => {
  if (!(await canEditCourse(db, uid, userId))) throw new AccessError(404, 'Course not found.');
};

// Gives `userId` a role on a course, so its devices sync it. Playing never takes away ownership;
// making someone an owner does what it says.
export const grantAccess = (db: Queryable, uid: string, userId: string, role: Role, now: number) => db.query(
  `INSERT INTO course_access (course_uid, user_id, role, updated_at) VALUES ($1, $2, $3, $4)
   ON CONFLICT (course_uid, user_id) DO UPDATE SET
     role = CASE WHEN course_access.removed OR EXCLUDED.role = 'owner' THEN EXCLUDED.role ELSE course_access.role END,
     removed = false, updated_at = EXCLUDED.updated_at, version = nextval('sync_version')
   WHERE course_access.removed OR (course_access.role <> EXCLUDED.role AND EXCLUDED.role = 'owner')`,
  [uid, userId, role, now],
);

type OwnerRow = { user_id: string; display_name: string; email: string; creator: boolean };

// A course's owners (its creator first), for an owner or a site admin. Emails are included, since
// owners are added by email.
export const listOwners = async (db: Queryable, uid: string, userId: string) => {
  await requireEditor(db, uid, userId);
  const { rows } = await db.query<OwnerRow>(
    `SELECT u.id AS user_id, u.display_name, u.email, true AS creator
     FROM courses c JOIN users u ON u.id = c.owner_id WHERE c.uid = $1
     UNION ALL
     SELECT u.id, u.display_name, u.email, false
     FROM course_access a JOIN users u ON u.id = a.user_id
     WHERE a.course_uid = $1 AND NOT a.removed AND a.role = 'owner'`,
    [uid],
  );
  const owners = [...rows].sort((a, b) => Number(b.creator) - Number(a.creator) || a.display_name.localeCompare(b.display_name));
  return { owners: owners.map((row) => ({ userId: row.user_id, displayName: row.display_name, email: row.email, creator: row.creator })) };
};

const isCreator = async (db: Queryable, uid: string, userId: string) =>
  (await db.query('SELECT 1 FROM courses WHERE uid = $1 AND owner_id = $2', [uid, userId])).rows.length > 0;

// An owner or site admin makes the account using `email` an owner of the course.
export const addOwner = async (db: Queryable, uid: string, userId: string, email: string, now: number) => {
  await requireEditor(db, uid, userId);
  const { rows } = await db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  const invitee = rows[0];
  if (!invitee) throw new AccessError(404, 'No Glide Path account uses that email. They need to create one first.');
  if (!(await isCreator(db, uid, invitee.id))) await grantAccess(db, uid, invitee.id, 'owner', now);
  return listOwners(db, uid, userId);
};

// An owner or site admin removes an owner (or themselves); they can still play the course. Its
// creator always stays an owner.
export const removeOwner = async (db: Queryable, uid: string, userId: string, ownerId: string, now: number) => {
  await requireEditor(db, uid, userId);
  if (await isCreator(db, uid, ownerId)) throw new AccessError(400, 'The person who created a course is always one of its owners.');
  await db.query(
    `UPDATE course_access SET role = 'player', updated_at = $3, version = nextval('sync_version')
     WHERE course_uid = $1 AND user_id = $2 AND NOT removed AND role = 'owner'`,
    [uid, ownerId, now],
  );
};

// Anyone signed in can play any course: this keeps it on their devices.
export const playCourse = async (db: Queryable, uid: string, userId: string, now: number) => {
  const { rows } = await db.query<{ owner_id: string }>('SELECT owner_id FROM courses WHERE uid = $1 AND NOT deleted', [uid]);
  if (!rows[0]) throw new AccessError(404, 'Course not found.');
  if (rows[0].owner_id !== userId) await grantAccess(db, uid, userId, 'player', now);
};

// Before an account is deleted, each course it created passes to another of its owners, the
// longest-standing first, so the people who play it keep it. The course takes the id that owner
// already knows it by (shared-<uid>). A course with no other owner is deleted with the account.
export const handOverCourses = async (db: Queryable, userId: string) => {
  const { rows } = await db.query<{ uid: string; heir: string | null }>(
    `SELECT c.uid, (
       SELECT a.user_id FROM course_access a
       WHERE a.course_uid = c.uid AND NOT a.removed AND a.role = 'owner' AND a.user_id <> $1
       ORDER BY a.version ASC LIMIT 1
     ) AS heir
     FROM courses c WHERE c.owner_id = $1 AND NOT c.deleted`,
    [userId],
  );
  for (const { uid, heir } of rows) {
    if (!heir) continue;
    await db.query(
      `UPDATE courses SET owner_id = $2, client_id = 'shared-' || uid, version = nextval('sync_version') WHERE uid = $1`,
      [uid, heir],
    );
    await db.query('DELETE FROM course_access WHERE course_uid = $1 AND user_id = $2', [uid, heir]);
  }
};
