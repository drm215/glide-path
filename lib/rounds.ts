// Round data helpers shared by the app and its tests. Pure functions only.
import type { GpsPoint, HoleLayout, Shot } from './types';

type Point = Pick<GpsPoint, 'latitude' | 'longitude'>;

const EARTH_RADIUS_FEET = 20_902_231;

const feetBetween = (a: Point, b: Point) => {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * EARTH_RADIUS_FEET * Math.asin(Math.sqrt(h));
};

// Throw distances are measured from the previous logged lie (or the tee), so moving or
// removing a throw changes the distances after it. Throws without a position are left alone.
export const remeasureHole = (list: Shot[], holeNumber: number, tee: Point | null | undefined): Shot[] => {
  let previous: Point | null = tee ?? null;
  return list.map((shot) => {
    if (shot.hole !== holeNumber || shot.latitude === undefined || shot.longitude === undefined) return shot;
    const point = { latitude: shot.latitude, longitude: shot.longitude };
    const feet = previous ? Math.max(1, Math.round(feetBetween(previous, point))) : 0;
    previous = point;
    return feet === shot.feet ? shot : { ...shot, feet };
  });
};

// Throws that went in are recorded at the hole's basket. Rounds logged before that rule were
// placed wherever the player stood; this moves them and remeasures those holes.
// Returns the same array when nothing needed to change.
export const placeMadeThrowsAtBasket = (shots: Shot[], layouts: HoleLayout[] | undefined): Shot[] => {
  if (!layouts) return shots;
  const moved = new Set<number>();
  let next = shots.map((shot) => {
    const basket = layouts[shot.hole - 1]?.basket;
    if (shot.lie !== 'Basket' || !basket || (shot.latitude === basket.latitude && shot.longitude === basket.longitude)) return shot;
    moved.add(shot.hole);
    return { ...shot, latitude: basket.latitude, longitude: basket.longitude };
  });
  if (!moved.size) return shots;
  for (const hole of moved) next = remeasureHole(next, hole, layouts[hole - 1]?.tee);
  return next;
};
