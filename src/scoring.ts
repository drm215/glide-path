import type { Course, Shot, ThrowType } from '../lib/types';
import { OB_PENALTY_STROKES } from './constants';

// The next throw on a hole: a drive to start, a putt after a putt, otherwise an approach.
export const nextThrowType = (holeShots: Shot[]): ThrowType => {
  const last = holeShots.at(-1);
  return !last ? 'Drive' : last.type === 'Putt' ? 'Putt' : 'Approach';
};

// Score for a list of throws: every throw counts, plus a penalty stroke for each one out of bounds.
export const countStrokes = (list: Shot[]) => list.length + list.filter((shot) => shot.lie === 'OB').length * OB_PENALTY_STROKES;

// Score for a set of throws. A hole counts toward par once it's complete: it has a
// basket throw, or it isn't the hole currently being played.
export const scoreSummary = (sessionShots: Shot[], course: Course | undefined, currentHole?: number) => {
  const holes = [...new Set(sessionShots.map((shot) => shot.hole))];
  const holeShots = (holeNumber: number) => sessionShots.filter((shot) => shot.hole === holeNumber);
  const completed = holes.filter((holeNumber) => holeNumber !== currentHole || holeShots(holeNumber).some((shot) => shot.lie === 'Basket'));
  const scored = completed.flatMap((holeNumber) => {
    const par = course?.layouts?.[holeNumber - 1]?.par;
    return par === undefined ? [] : [countStrokes(holeShots(holeNumber)) - par];
  });
  return {
    strokes: countStrokes(sessionShots),
    holesCompleted: completed.length,
    holesWithPar: scored.length,
    toPar: scored.length ? scored.reduce((sum, diff) => sum + diff, 0) : null,
  };
};
