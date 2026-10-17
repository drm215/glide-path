// When a course's basket is moved, throws that went in on that hole move with it: a made throw is
// recorded at the basket (see recordThrow in the app), so in every round played on that layout it
// goes to the new spot and its distance is measured again, from the previous logged throw on the
// hole or the tee. Rounds are saved with a newer edit time, so every player's devices take them.
import type { CourseRecord, RoundRecord } from './contract.ts';
import type { Queryable } from './db.ts';
import { feetBetween } from './public.ts';

const MAIN_LAYOUT_ID = 'main';
const SHARED_COURSE_PREFIX = 'shared-';

type Point = { latitude: number; longitude: number; altitude?: number | null; accuracy?: number | null };
type Shot = RoundRecord['shots'][number] & { latitude?: number; longitude?: number; lie?: string };

const layoutsOf = (course: CourseRecord) => [
  { id: MAIN_LAYOUT_ID, holes: course.layouts },
  ...course.extraLayouts.map((layout) => ({ id: layout.id, holes: layout.layouts })),
];

const samePlace = (a: Point, b: Point) => a.latitude === b.latitude && a.longitude === b.longitude;

// The holes whose basket moved, by layout id: hole number → its new basket and the tee.
const basketMoves = (before: CourseRecord, after: CourseRecord) => {
  const moves = new Map<string, Map<number, { basket: Point; tee: Point | null }>>();
  for (const layout of layoutsOf(after)) {
    const old = layoutsOf(before).find((item) => item.id === layout.id);
    if (!old) continue;
    layout.holes.forEach((hole, index) => {
      const was = old.holes[index]?.basket;
      if (!hole?.basket || !was || samePlace(was, hole.basket)) return;
      if (!moves.has(layout.id)) moves.set(layout.id, new Map());
      moves.get(layout.id)!.set(index + 1, { basket: hole.basket, tee: hole.tee ?? null });
    });
  }
  return moves;
};

// `shots` with each made throw on a moved hole at its new basket and remeasured; null if none changed.
export const followBaskets = (shots: Shot[], moves: Map<number, { basket: Point; tee: Point | null }>) => {
  let changed = false;
  const last = new Map<number, Point>();
  const next = shots.map((shot) => {
    const move = moves.get(shot.hole);
    let result = shot;
    if (move && shot.lie === 'Basket') {
      const from = last.get(shot.hole) ?? move.tee;
      const { basket } = move;
      const feet = from ? Math.max(1, Math.round(feetBetween(from, basket))) : 0;
      if (shot.latitude !== basket.latitude || shot.longitude !== basket.longitude || shot.feet !== feet) {
        result = { ...shot, latitude: basket.latitude, longitude: basket.longitude, altitude: basket.altitude ?? null, accuracy: basket.accuracy ?? null, feet };
        changed = true;
      }
    }
    if (typeof result.latitude === 'number' && typeof result.longitude === 'number') last.set(result.hole, result as Point);
    return result;
  });
  return changed ? next : null;
};

// Moves made throws in the rounds on course `after` (owned by `ownerId`) to its moved baskets.
export const followBasketMoves = async (tx: Queryable, ownerId: string, before: CourseRecord, after: CourseRecord, now: number) => {
  const moves = basketMoves(before, after);
  if (!moves.size) return;
  const { rows: [course] } = await tx.query<{ uid: string }>('SELECT uid FROM courses WHERE owner_id = $1 AND client_id = $2', [ownerId, after.clientId]);
  if (!course) return;
  const { rows } = await tx.query<{ owner_id: string; client_id: string; layout_id: string | null; shots: Shot[] }>(
    `SELECT owner_id, client_id, layout_id, shots FROM rounds
     WHERE NOT deleted AND ((owner_id = $1 AND course_client_id = $2) OR course_client_id = '${SHARED_COURSE_PREFIX}' || $3)
       AND COALESCE(layout_id, '${MAIN_LAYOUT_ID}') = ANY($4)
     FOR UPDATE`,
    [ownerId, after.clientId, course.uid, [...moves.keys()]],
  );
  for (const round of rows) {
    const shots = followBaskets(round.shots, moves.get(round.layout_id ?? MAIN_LAYOUT_ID)!);
    if (!shots) continue;
    await tx.query(
      `UPDATE rounds SET shots = $3, updated_at = GREATEST(updated_at + 1, $4), version = nextval('sync_version')
       WHERE owner_id = $1 AND client_id = $2`,
      [round.owner_id, round.client_id, JSON.stringify(shots), now],
    );
  }
};
