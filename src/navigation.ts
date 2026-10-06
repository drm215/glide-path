// Screens and their routes (files in src/app). Forward moves open a screen on top of the current
// one; back moves close screens until the target is on top, or replace the current screen when the
// target isn't open, so each back button lands where it always has.
import { router } from 'expo-router';

export type Screen = 'Home' | 'CourseBuilder' | 'NewCourse' | 'HoleWizard' | 'BagBuilder' | 'Practice' | 'Round' | 'Insights' | 'Rounds' | 'Account' | 'FindCourses';

export const PATHS = {
  Home: '/',
  CourseBuilder: '/courses',
  NewCourse: '/courses/new',
  HoleWizard: '/courses/map',
  BagBuilder: '/bag',
  Practice: '/practice',
  Round: '/round',
  Insights: '/stats',
  Rounds: '/rounds',
  Account: '/account',
  FindCourses: '/find',
} as const satisfies Record<Screen, string>;

export const go = (screen: Screen) => router.push(PATHS[screen]);

export const backTo = (screen: Screen) => router.dismissTo(PATHS[screen]);

// Back to whichever screen opened this one, for screens reached from more than one place.
export const goBack = () => {
  if (router.canGoBack()) router.back();
  else router.replace(PATHS.Home);
};

// Every recorded throw on one hole of a course layout. `includePractice` adds practice sessions.
export const openHoleHistory = (courseId: string, layoutId: string, hole: number, includePractice = false) =>
  router.push({ pathname: '/hole', params: { course: courseId, layout: layoutId, hole: String(hole), ...(includePractice ? { practice: '1' } : {}) } });

// Hole mapping for the selected course and layout; `from` is where FINISH returns to.
export const openHoleMapping = (from: 'CourseBuilder' | 'NewCourse') =>
  router.push({ pathname: PATHS.HoleWizard, params: from === 'NewCourse' ? { from: 'new' } : {} });

// A past round's summary. A round that was just finished opens over the home screen, so going back
// from its summary doesn't return to a round that has ended.
export const openRound = (id: string, justFinished = false) => {
  if (justFinished) router.dismissTo(PATHS.Home);
  router.push({ pathname: '/rounds/[id]', params: justFinished ? { id, summary: '1' } : { id } });
};
