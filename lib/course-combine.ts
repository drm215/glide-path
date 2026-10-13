// Combining two courses that are really the same one (mapped separately by two people) into one:
// the course kept gains the other's holes and layouts, and rounds on the other move to it. Pure,
// so it can be tested on its own.
import { MAIN_LAYOUT_ID } from './layouts';
import { canEditCourse } from './public-course';
import type { Course, CourseLayout, GpsPoint, HoleLayout } from './types';

type Layout = { id: string; name: string; layouts: HoleLayout[] };

const layoutsOf = (course: Course): Layout[] => [
  { id: MAIN_LAYOUT_ID, name: course.layoutName || 'Main', layouts: course.layouts ?? [] },
  ...(course.extraLayouts ?? []).map(({ id, name, layouts }) => ({ id, name, layouts })),
];

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const savedAt = (point: GpsPoint | null | undefined) => point?.timestamp ?? 0;
const later = (a: GpsPoint | null, b: GpsPoint | null) => (savedAt(b) > savedAt(a) ? b : a ?? b);
const hasPoint = (layout: HoleLayout | undefined) => Boolean(layout?.tee || layout?.basket);

// `kept`'s holes, each with the more recently saved tee and basket of the two and its own par
// (the other's if it has none). Holes past its end that the other has mapped are added.
const combineHoles = (kept: HoleLayout[], other: HoleLayout[]) => {
  let count = kept.length;
  other.forEach((layout, index) => { if (index >= count && hasPoint(layout)) count = index + 1; });
  return Array.from({ length: count }, (_, index) => {
    const mine = kept[index];
    const theirs = other[index];
    if (!mine) return theirs ?? { tee: null, basket: null };
    if (!theirs) return mine;
    return { ...mine, tee: later(mine.tee, theirs.tee), basket: later(mine.basket, theirs.basket), par: mine.par ?? theirs.par };
  });
};

// `source` combined into `target`: each of source's layouts joins target's layout with the same
// id or name, and any other is added as a new layout. Returns the combined target and, for each
// of source's layout ids, the target layout id its rounds should now use.
export const combineCourses = (source: Course, target: Course, now = Date.now()) => {
  const targetLayouts = layoutsOf(target);
  let main = target.layouts ?? [];
  let extras: CourseLayout[] = [...(target.extraLayouts ?? [])];
  const layoutIds = new Map<string, string>();
  layoutsOf(source).forEach((layout, index) => {
    const match = targetLayouts.find((item) => item.id === layout.id) ?? targetLayouts.find((item) => sameName(item.name, layout.name));
    if (match?.id === MAIN_LAYOUT_ID) {
      main = combineHoles(main, layout.layouts);
    } else if (match) {
      extras = extras.map((extra) => (extra.id === match.id ? { ...extra, layouts: combineHoles(extra.layouts, layout.layouts), holes: Math.max(extra.holes, combineHoles(extra.layouts, layout.layouts).length) } : extra));
    } else {
      const taken = layout.id === MAIN_LAYOUT_ID || extras.some((extra) => extra.id === layout.id);
      const id = taken ? `layout-${now}-${index}` : layout.id;
      extras = [...extras, { id, name: layout.name, holes: layout.layouts.length, layouts: layout.layouts }];
      layoutIds.set(layout.id, id);
      return;
    }
    layoutIds.set(layout.id, match.id);
  });
  return { course: { ...target, holes: main.length, layouts: main, extraLayouts: extras }, layoutIds };
};

// Other courses with the same name as `course` that it could be combined into: it's deleted, so
// this account has to be able to edit both.
export const duplicatesOf = (course: Course, courses: Course[]) =>
  canEditCourse(course) ? courses.filter((other) => other.id !== course.id && canEditCourse(other) && sameName(other.name, course.name)) : [];
