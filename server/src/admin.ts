// Site admins: everything owners can do, on every course (see courses.ts and access.ts), plus
// accounts (making and removing admins, deleting accounts) and combining duplicate courses.
import { AccessError, grantAccess, handOverCourses, isSiteAdmin } from './access.ts';
import type { Queryable } from './db.ts';
import { combineCourseRecords } from './course-merge.ts';
import { courseFromRow, SHARED_COURSE_PREFIX, writeCourse } from './sync.ts';

export const requireAdmin = async (db: Queryable, userId: string) => {
  if (!(await isSiteAdmin(db, userId))) throw new AccessError(403, 'Only site admins can do that.');
};

// Search text for ILIKE, with its wildcards escaped.
const like = (query: string) => `%${query.trim().replace(/[\\%_]/g, (match) => `\\${match}`)}%`;

// Every live course (matching `query`, if given), with who created it and how much it's played.
export const listAllCourses = async (db: Queryable, query: string) => {
  const { rows } = await db.query<{ uid: string; name: string; city: string | null; state: string | null; hole_count: number; layouts: number; created_by: string; rounds: string; players: string }>(
    `SELECT c.uid, c.name, c.city, c.state, c.hole_count, jsonb_array_length(c.extra_layouts) + 1 AS layouts, u.display_name AS created_by,
       (SELECT count(*) FROM rounds r WHERE NOT r.deleted
          AND (r.course_client_id = '${SHARED_COURSE_PREFIX}' || c.uid OR (r.owner_id = c.owner_id AND r.course_client_id = c.client_id))) AS rounds,
       (SELECT count(*) FROM course_access a WHERE a.course_uid = c.uid AND NOT a.removed) AS players
     FROM courses c JOIN users u ON u.id = c.owner_id
     WHERE NOT c.deleted AND ($1 = '' OR c.name ILIKE $2 OR c.city ILIKE $2 OR c.state ILIKE $2 OR u.display_name ILIKE $2)
     ORDER BY lower(c.name) LIMIT 200`,
    [query.trim(), like(query)],
  );
  return rows.map((row) => ({
    uid: row.uid, name: row.name, city: row.city, state: row.state, holes: row.hole_count, layouts: Number(row.layouts),
    createdBy: row.created_by, rounds: Number(row.rounds), players: Number(row.players),
  }));
};

// Every account (matching `query`, if given), newest first.
export const listUsers = async (db: Queryable, query: string) => {
  const { rows } = await db.query<{ id: string; email: string; display_name: string; is_admin: boolean; created_at: Date | string; courses: string; rounds: string }>(
    `SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at,
       (SELECT count(*) FROM courses c WHERE c.owner_id = u.id AND NOT c.deleted) AS courses,
       (SELECT count(*) FROM rounds r WHERE r.owner_id = u.id AND NOT r.deleted) AS rounds
     FROM users u WHERE $1 = '' OR u.email ILIKE $2 OR u.display_name ILIKE $2
     ORDER BY u.created_at DESC LIMIT 200`,
    [query.trim(), like(query)],
  );
  return rows.map((row) => ({
    id: row.id, email: row.email, displayName: row.display_name, isAdmin: row.is_admin,
    createdAt: new Date(row.created_at).getTime(), courses: Number(row.courses), rounds: Number(row.rounds),
  }));
};

// Makes an account an admin, or stops it being one. The site always keeps at least one admin.
export const setAdmin = async (db: Queryable, userId: string, isAdmin: boolean) => {
  if (!isAdmin) {
    const { rows } = await db.query<{ others: string }>('SELECT count(*) AS others FROM users WHERE is_admin AND id <> $1', [userId]);
    if (Number(rows[0].others) === 0) throw new AccessError(400, 'The site needs at least one admin.');
  }
  const { rows } = await db.query('UPDATE users SET is_admin = $2 WHERE id = $1 RETURNING id', [userId, isAdmin]);
  if (!rows.length) throw new AccessError(404, 'Account not found.');
};

// Deletes an account, as it can itself: its courses pass to another owner first. Not the last admin.
export const deleteAccount = async (db: Queryable, userId: string) => {
  const { rows } = await db.query<{ is_admin: boolean; others: string }>(
    'SELECT is_admin, (SELECT count(*) FROM users WHERE is_admin AND id <> $1) AS others FROM users WHERE id = $1',
    [userId],
  );
  if (!rows[0]) throw new AccessError(404, 'Account not found.');
  if (rows[0].is_admin && Number(rows[0].others) === 0) throw new AccessError(400, 'The site needs at least one admin.');
  await handOverCourses(db, userId);
  await db.query('DELETE FROM users WHERE id = $1', [userId]);
};

type CourseRow = Parameters<typeof courseFromRow>[0];

// Combines `sourceUid` into `targetUid`, two courses that are really the same place: target gains
// source's holes and layouts; every round on source, whoever played it, moves to target (and its
// matching layout); everyone who owned or played source owns or plays target; and source is
// deleted. Phones pick all of that up on their next sync.
export const combineCourses = async (tx: Queryable, sourceUid: string, targetUid: string, now: number) => {
  if (sourceUid === targetUid) throw new AccessError(400, 'Pick two different courses.');
  const { rows } = await tx.query<CourseRow>('SELECT * FROM courses WHERE uid = ANY($1::uuid[]) AND NOT deleted FOR UPDATE', [[sourceUid, targetUid]]);
  const sourceRow = rows.find((row) => row.uid === sourceUid);
  const targetRow = rows.find((row) => row.uid === targetUid);
  if (!sourceRow || !targetRow) throw new AccessError(404, 'Course not found.');
  const source = courseFromRow(sourceRow);
  const target = courseFromRow(targetRow);
  const { course, layoutIds } = combineCourseRecords(source, target, now);
  await writeCourse(tx, targetRow.owner_id, { ...course, published: true, updatedAt: Math.max(now, target.updatedAt + 1, source.updatedAt + 1) });

  // Rounds: to target's id as each player knows it (its creator's own id, or shared-<uid>), and to
  // the matching layout, with an edit time that makes phones take the change.
  await tx.query(
    `UPDATE rounds SET
       layout_id = NULLIF(($4::jsonb ->> COALESCE(layout_id, 'main')), 'main'),
       course_client_id = CASE WHEN owner_id = $5 THEN $6 ELSE '${SHARED_COURSE_PREFIX}' || $7 END,
       course_name = $8,
       updated_at = GREATEST(updated_at + 1, $9), version = nextval('sync_version')
     WHERE (owner_id = $1 AND course_client_id = $2) OR course_client_id = '${SHARED_COURSE_PREFIX}' || $3`,
    [sourceRow.owner_id, sourceRow.client_id, sourceUid, JSON.stringify(layoutIds), targetRow.owner_id, targetRow.client_id, targetUid, course.name, now],
  );

  // Access: source's owners (its creator included) own target; its players play it.
  const { rows: access } = await tx.query<{ user_id: string; role: 'owner' | 'player' }>(
    `SELECT user_id, role FROM course_access WHERE course_uid = $1 AND NOT removed
     UNION SELECT $2::uuid, 'owner'`,
    [sourceUid, sourceRow.owner_id],
  );
  for (const { user_id: userId, role } of access) {
    if (userId !== targetRow.owner_id) await grantAccess(tx, targetUid, userId, role, now);
  }
  await tx.query(`UPDATE course_access SET removed = true, updated_at = $2, version = nextval('sync_version') WHERE course_uid = $1 AND NOT removed`, [sourceUid, now]);

  // Source goes, remembering where, so rounds still naming it that arrive later move too.
  await writeCourse(tx, sourceRow.owner_id, { ...source, deleted: true, updatedAt: Math.max(now, source.updatedAt + 1) });
  await tx.query(
    `UPDATE courses SET merged_into_uid = $2::uuid, merged_into = CASE WHEN owner_id = $3 THEN $4 ELSE '${SHARED_COURSE_PREFIX}' || $2::text END WHERE uid = $1`,
    [sourceUid, targetUid, targetRow.owner_id, targetRow.client_id],
  );
  return { uid: targetUid };
};
