// Every recorded visit to one hole of a course layout, across past rounds (and practice sessions).
import { MAIN_LAYOUT_ID } from '../lib/layouts';
import type { SessionArchive, Shot } from '../lib/types';
import { countStrokes } from './scoring';

export type HoleVisit = { session: SessionArchive; shots: Shot[]; strokes: number };

// Finished sessions played on this course and layout (rounds, plus practice when `includePractice`).
const sessionsOn = (history: SessionArchive[], courseId: string, layoutId: string, includePractice: boolean) =>
  history.filter((session) => !session.inProgress && session.courseId === courseId && (session.layoutId ?? MAIN_LAYOUT_ID) === layoutId && (includePractice || session.mode === 'Round'));

// The visits to one hole, newest first.
export const holeVisits = (history: SessionArchive[], courseId: string, layoutId: string, hole: number, includePractice: boolean): HoleVisit[] =>
  sessionsOn(history, courseId, layoutId, includePractice)
    .map((session) => {
      const shots = session.shots.filter((shot) => shot.hole === hole);
      return { session, shots, strokes: countStrokes(shots) };
    })
    .filter((visit) => visit.shots.length > 0)
    .sort((a, b) => Number(b.session.id) - Number(a.session.id));

// Scores on a hole from rounds (practice doesn't count toward scoring): how many, average and best.
export const holeScoring = (visits: HoleVisit[]) => {
  const scores = visits.filter((visit) => visit.session.mode === 'Round').map((visit) => visit.strokes);
  return {
    rounds: scores.length,
    average: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
    best: scores.length ? Math.min(...scores) : null,
    scores,
  };
};

// The holes played on a course, by layout: each layout's holes in order, with their visits.
export const holesPlayed = (history: SessionArchive[], courseId: string, includePractice: boolean) => {
  const layouts = new Map<string, number[]>();
  for (const session of history) {
    if (session.inProgress || session.courseId !== courseId || (!includePractice && session.mode !== 'Round')) continue;
    const layoutId = session.layoutId ?? MAIN_LAYOUT_ID;
    const holes = new Set([...(layouts.get(layoutId) ?? []), ...session.shots.map((shot) => shot.hole)]);
    layouts.set(layoutId, [...holes].sort((a, b) => a - b));
  }
  return [...layouts.entries()].map(([layoutId, holes]) => ({
    layoutId,
    holes: holes.map((hole) => ({ hole, visits: holeVisits(history, courseId, layoutId, hole, includePractice) })),
  }));
};
