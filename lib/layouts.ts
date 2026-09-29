import type { Course, CourseLayout } from './types';

// The main layout lives in the course's own `holes`/`layouts` fields, so courses from before
// layouts existed, and older app versions, keep working unchanged.
export const MAIN_LAYOUT_ID = 'main';

export const layoutDisplayName = (layout: Pick<CourseLayout, 'id' | 'name'>) =>
  layout.name.trim() || (layout.id === MAIN_LAYOUT_ID ? 'Main' : 'Untitled layout');

export const courseLayouts = (course: Course): CourseLayout[] => [
  { id: MAIN_LAYOUT_ID, name: course.layoutName ?? '', holes: course.holes, layouts: course.layouts ?? [] },
  ...(course.extraLayouts ?? []),
];

export type CourseView = Course & { layoutId: string; layoutLabel: string };

const view = (course: Course, layout: CourseLayout): CourseView => ({
  ...course,
  holes: layout.holes,
  layouts: layout.layouts,
  layoutId: layout.id,
  layoutLabel: layoutDisplayName(layout),
});

// The course seen through one layout; an unknown id falls back to the main layout.
export const withLayout = (course: Course, layoutId: string | undefined): CourseView => {
  const layouts = courseLayouts(course);
  return view(course, layouts.find((layout) => layout.id === layoutId) ?? layouts[0]);
};

// For past rounds: a layout that has since been deleted gives no view, so its pars aren't guessed.
export const withExistingLayout = (course: Course, layoutId: string | undefined): CourseView | undefined => {
  const layout = courseLayouts(course).find((item) => item.id === (layoutId ?? MAIN_LAYOUT_ID));
  return layout ? view(course, layout) : undefined;
};

// Applies a change to one layout, writing the main layout back into the course's own fields.
export const updateLayoutIn = (course: Course, layoutId: string, change: (layout: CourseLayout) => CourseLayout): Course => {
  const extra = course.extraLayouts?.find((layout) => layout.id === layoutId);
  if (!extra) {
    const main = change(courseLayouts(course)[0]);
    return { ...course, holes: main.holes, layouts: main.layouts, layoutName: main.name || undefined };
  }
  return { ...course, extraLayouts: course.extraLayouts!.map((layout) => (layout === extra ? change(layout) : layout)) };
};
