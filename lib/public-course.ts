// Courses from the server's public directory (every course is public), as this app's courses.
import type { PublicCourse } from './api';
import type { Course, HoleLayout } from './types';

// A course someone else created has this id on this phone: shared-<its uid>, matching the
// server's (see server/src/sync.ts).
export const sharedCourseId = (uid: string) => `shared-${uid}`;

// Whether this account can change a course: one it created, or is an owner or admin of. Courses
// made here and not synced yet have no role and are this account's own.
export const canEditCourse = (course: Course) => course.role !== 'player';

// A course from the directory, to play: the live course (not a copy), which this account plays.
export const playedCourse = (source: PublicCourse): Course => {
  const layouts: HoleLayout[] = Array.from({ length: source.holes }, (_, index) => {
    const layout = source.layouts[index];
    return { tee: layout?.tee ?? null, basket: layout?.basket ?? null, par: layout?.par };
  });
  const { address, street, city, state, phone, email, website, notes } = source.details;
  return {
    id: sharedCourseId(source.uid), uid: source.uid, role: 'player', createdBy: source.mappedBy,
    name: source.name, holes: source.holes, layouts, layoutName: source.layoutName,
    extraLayouts: (source.extraLayouts ?? []).map(({ id, name, holes, layouts: holeLayouts }) => ({ id, name, holes, layouts: holeLayouts })),
    address, street, city, state, phone, email, website, notes,
    published: true, updatedAt: source.updatedAt, serverUpdatedAt: source.updatedAt,
  };
};
