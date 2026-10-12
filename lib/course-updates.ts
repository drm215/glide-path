// Courses copied from the public directory follow their publisher's updates, with two guardrails:
// a copy that's been edited on the phone stops following (so the player's own changes aren't
// overwritten), and the app doesn't update while a round is being played.
import type { PublicCourse } from './api';
import type { Course, HoleLayout } from './types';

// Whether a copy still takes its publisher's updates: it came from the directory and hasn't been
// edited since it last took one. Copies made before this was tracked have no sourceSyncedAt and
// follow, since there's no telling whether they were edited.
export const followsPublisher = (course: Course) =>
  Boolean(course.sourceUid) && (course.sourceSyncedAt === undefined || (course.updatedAt ?? 0) <= course.sourceSyncedAt);

// The published course's content, as a course's fields: its name, layouts, pars and details.
export const publisherContent = (source: PublicCourse) => {
  const layouts: HoleLayout[] = Array.from({ length: source.holes }, (_, index) => {
    const layout = source.layouts[index];
    return { tee: layout?.tee ?? null, basket: layout?.basket ?? null, par: layout?.par };
  });
  const { address, street, city, state, phone, email, website, notes } = source.details;
  return {
    name: source.name, holes: source.holes, layouts, layoutName: source.layoutName,
    extraLayouts: (source.extraLayouts ?? []).map(({ id, name, holes, layouts: holeLayouts }) => ({ id, name, holes, layouts: holeLayouts })),
    address, street, city, state, phone, email, website, notes,
  };
};

// A copy brought up to the published version at `now`. It keeps its id, so rounds played on it
// stay linked (and keep the pars they were played with), and the new edit time syncs it.
export const updatedFromPublisher = (course: Course, source: PublicCourse, now: number): Course => ({
  ...course,
  ...publisherContent(source),
  sourceUid: source.uid,
  sourceUpdatedAt: source.updatedAt,
  sourceSyncedAt: now,
  updatedAt: now,
});

// Whether the publisher has changed the course since this copy took it. Copies from before
// versions were tracked have none, so they take the latest once.
export const hasNewerVersion = (course: Course, publishedAt: number) => publishedAt > (course.sourceUpdatedAt ?? 0);
