// Combining two saves of the same course, so one device's edits can't silently replace another's.
// A course syncs as one record, and the newer save used to win outright: a device that mapped
// holes, then synced after another device had saved the course, lost its upload without a word.
// A save made on top of the stored version replaces it as sent (so deletions stand); one made on
// top of an older version (the device missed another's changes) is merged with it: tees and
// baskets record when they were saved, so each keeps its latest position; layouts and holes that
// only one save has are kept; and the rest (name, details, pars, layout names, publishing) comes
// from the newer save.
import type { CourseRecord } from './contract.ts';

type HoleLayout = CourseRecord['layouts'][number];
type Point = NonNullable<HoleLayout['tee']>;

const savedAt = (point: Point | null) => point?.timestamp ?? 0;
const later = (a: Point | null, b: Point | null) => (savedAt(b) > savedAt(a) ? b : a ?? b);
const hasPoint = (layout: HoleLayout | undefined) => Boolean(layout?.tee || layout?.basket);

// `newer`'s holes, each with the later-saved tee and basket of the two. Holes past the end of
// `newer` that have a point in `older` are kept, so holes mapped on one device aren't dropped.
const mergeHoles = (newer: HoleLayout[], older: HoleLayout[]) => {
  let count = newer.length;
  older.forEach((layout, index) => { if (index >= count && hasPoint(layout)) count = index + 1; });
  return Array.from({ length: count }, (_, index) => {
    const mine = newer[index];
    const theirs = older[index];
    if (!mine) return theirs!;
    if (!theirs) return mine;
    return { ...mine, tee: later(mine.tee, theirs.tee), basket: later(mine.basket, theirs.basket), par: mine.par ?? theirs.par };
  });
};

// The two saves combined. Deleting a course isn't merged: a deletion stands as sent.
export const mergeCourseRecords = (stored: CourseRecord, incoming: CourseRecord): CourseRecord => {
  const [newer, older] = incoming.updatedAt > stored.updatedAt ? [incoming, stored] : [stored, incoming];
  if (newer.deleted || older.deleted) return newer;
  const layouts = mergeHoles(newer.layouts, older.layouts);
  const olderExtras = new Map(older.extraLayouts.map((layout) => [layout.id, layout]));
  const extraLayouts = [
    ...newer.extraLayouts.map((layout) => {
      const theirs = olderExtras.get(layout.id);
      const holes = theirs ? mergeHoles(layout.layouts, theirs.layouts) : layout.layouts;
      return { ...layout, holes: holes.length, layouts: holes };
    }),
    // A layout only the older save has is kept when it has mapped holes; an empty one stays deleted.
    ...older.extraLayouts.filter((layout) => !newer.extraLayouts.some((item) => item.id === layout.id) && layout.layouts.some(hasPoint)),
  ];
  return { ...newer, holes: layouts.length, layouts, extraLayouts };
};

// JSON with object keys sorted and undefined values dropped, so equal content compares equal
// whichever order its fields arrived in.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

// Whether two course records hold the same content (ignoring their edit times).
export const sameCourse = (a: CourseRecord, b: CourseRecord) => canonical({ ...a, updatedAt: 0 }) === canonical({ ...b, updatedAt: 0 });

// Combining two courses that are really the same place (see admin.ts): `target` gains `source`'s
// holes and layouts. Each of source's layouts joins target's layout with the same id or name (the
// main one is 'main'), and any other is added as a new layout. Matches lib/course-combine.ts in the
// app. Returns the combined target and, for each of source's layout ids, target's layout id.
const MAIN_LAYOUT_ID = 'main';
type Layout = { id: string; name: string; layouts: HoleLayout[] };
const layoutsOf = (course: CourseRecord): Layout[] => [
  { id: MAIN_LAYOUT_ID, name: course.layoutName || 'Main', layouts: course.layouts },
  ...course.extraLayouts.map(({ id, name, layouts }) => ({ id, name, layouts })),
];
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const combineCourseRecords = (source: CourseRecord, target: CourseRecord, now: number) => {
  const targetLayouts = layoutsOf(target);
  let main = target.layouts;
  let extras = [...target.extraLayouts];
  const layoutIds: Record<string, string> = {};
  layoutsOf(source).forEach((layout, index) => {
    const match = targetLayouts.find((item) => item.id === layout.id) ?? targetLayouts.find((item) => sameName(item.name, layout.name));
    if (match?.id === MAIN_LAYOUT_ID) {
      main = mergeHoles(main, layout.layouts);
    } else if (match) {
      extras = extras.map((extra) => {
        if (extra.id !== match.id) return extra;
        const holes = mergeHoles(extra.layouts, layout.layouts);
        return { ...extra, holes: holes.length, layouts: holes };
      });
    } else {
      const taken = layout.id === MAIN_LAYOUT_ID || extras.some((extra) => extra.id === layout.id);
      const id = taken ? `layout-${now}-${index}` : layout.id;
      extras = [...extras, { id, name: layout.name, holes: layout.layouts.length, layouts: layout.layouts }];
      layoutIds[layout.id] = id;
      return;
    }
    layoutIds[layout.id] = match.id;
  });
  return { course: { ...target, holes: main.length, layouts: main, extraLayouts: extras }, layoutIds };
};
