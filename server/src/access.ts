// Who can do what with a course. Every course is public: anyone signed in can find it and play
// it. Its creator is an owner, and owners and admins (the same rights) can edit it, invite other
// accounts as owners or admins, remove them, and delete it. An account that plays a course has a
// player row, so its devices keep the course up to date (see sync.ts).
import type { Queryable } from './db.ts';

export type Role = 'owner' | 'admin' | 'player';
export const canEdit = (role: Role | null | undefined) => role === 'owner' || role === 'admin';

export class AccessError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// `userId`'s role on a live course: owner for its creator, else from course_access; null if none.
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

// Gives `userId` a role on a course, so its devices sync the course. Playing never lowers a role
// someone already has; inviting as owner or admin sets it.
export const grantAccess = (db: Queryable, uid: string, userId: string, role: Role, now: number) => db.query(
  `INSERT INTO course_access (course_uid, user_id, role, updated_at) VALUES ($1, $2, $3, $4)
   ON CONFLICT (course_uid, user_id) DO UPDATE SET
     role = CASE WHEN course_access.removed OR EXCLUDED.role <> 'player' THEN EXCLUDED.role ELSE course_access.role END,
     removed = false, updated_at = EXCLUDED.updated_at, version = nextval('sync_version')
   WHERE course_access.removed OR course_access.role <> EXCLUDED.role AND (EXCLUDED.role <> 'player')`,
  [uid, userId, role, now],
);

type EditorRow = { user_id: string; display_name: string; email: string; role: Role; creator: boolean };

// A course's owners and admins (its creator first), for one of them. Emails are included, since
// they invite by email.
export const listEditors = async (db: Queryable, uid: string, userId: string) => {
  if (!canEdit(await roleOn(db, uid, userId))) throw new AccessError(404, 'Course not found.');
  const { rows } = await db.query<EditorRow>(
    `SELECT u.id AS user_id, u.display_name, u.email, 'owner' AS role, true AS creator
     FROM courses c JOIN users u ON u.id = c.owner_id WHERE c.uid = $1
     UNION ALL
     SELECT u.id, u.display_name, u.email, a.role, false
     FROM course_access a JOIN users u ON u.id = a.user_id
     WHERE a.course_uid = $1 AND NOT a.removed AND a.role IN ('owner', 'admin')`,
    [uid],
  );
  const editors = [...rows].sort((a, b) => Number(b.creator) - Number(a.creator) || a.display_name.localeCompare(b.display_name));
  return { editors: editors.map((row) => ({ userId: row.user_id, displayName: row.display_name, email: row.email, role: row.role, creator: row.creator })) };
};

// An owner or admin invites the account using `email` as an owner or admin.
export const addEditor = async (db: Queryable, uid: string, userId: string, email: string, role: 'owner' | 'admin', now: number) => {
  if (!canEdit(await roleOn(db, uid, userId))) throw new AccessError(404, 'Course not found.');
  const { rows } = await db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  const invitee = rows[0];
  if (!invitee) throw new AccessError(404, 'No Glide Path account uses that email. They need to create one first.');
  const current = await roleOn(db, uid, invitee.id);
  if (current === 'owner' && role === 'admin' && (await isCreator(db, uid, invitee.id))) throw new AccessError(400, 'They created this course, so they’re always an owner.');
  await grantAccess(db, uid, invitee.id, role, now);
  return listEditors(db, uid, userId);
};

const isCreator = async (db: Queryable, uid: string, userId: string) =>
  (await db.query('SELECT 1 FROM courses WHERE uid = $1 AND owner_id = $2', [uid, userId])).rows.length > 0;

// An owner or admin removes another's (or their own) owner or admin role; they can still play it.
// The course's creator always stays an owner.
export const removeEditor = async (db: Queryable, uid: string, userId: string, editorId: string, now: number) => {
  if (!canEdit(await roleOn(db, uid, userId))) throw new AccessError(404, 'Course not found.');
  if (await isCreator(db, uid, editorId)) throw new AccessError(400, 'The person who created a course is always one of its owners.');
  await db.query(
    `UPDATE course_access SET role = 'player', updated_at = $3, version = nextval('sync_version')
     WHERE course_uid = $1 AND user_id = $2 AND NOT removed AND role <> 'player'`,
    [uid, editorId, now],
  );
};

// Anyone signed in can play any course: this keeps it on their devices.
export const playCourse = async (db: Queryable, uid: string, userId: string, now: number) => {
  const { rows } = await db.query<{ owner_id: string }>('SELECT owner_id FROM courses WHERE uid = $1 AND NOT deleted', [uid]);
  if (!rows[0]) throw new AccessError(404, 'Course not found.');
  if (rows[0].owner_id !== userId) await grantAccess(db, uid, userId, 'player', now);
};

// Before an account is deleted, each course it created passes to another of its owners (or, if it
// has none, an admin), longest-standing first, so the people who play it keep it. The course takes
// the id that owner already knows it by (shared-<uid>). A course with no other owner or admin is
// deleted with the account.
export const handOverCourses = async (db: Queryable, userId: string) => {
  const { rows } = await db.query<{ uid: string; heir: string | null }>(
    `SELECT c.uid, (
       SELECT a.user_id FROM course_access a
       WHERE a.course_uid = c.uid AND NOT a.removed AND a.role IN ('owner', 'admin') AND a.user_id <> $1
       ORDER BY a.role = 'owner' DESC, a.version ASC LIMIT 1
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
