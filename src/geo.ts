import type { Course, GpsPoint, HoleLayout } from '../lib/types';

// Deliberately tighter than any map can render; the map clamps to its maximum zoom level.
export const MAP_VIEW_WIDTH_FEET = 20;
export const MAP_SCALE_BAR_OPTIONS_FEET = [5, 10, 25, 50, 100];
export const METERS_PER_DEGREE = 111_320;
export const EARTH_RADIUS_METERS = 6_371_000;

export type MapRegion = { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };

export const isGpsPoint = (point: unknown): point is GpsPoint => {
  if (!point || typeof point !== 'object') return false;
  const candidate = point as Partial<GpsPoint>;
  return typeof candidate.latitude === 'number' && typeof candidate.longitude === 'number';
};

export const feetBetween = (a: Pick<GpsPoint, 'latitude' | 'longitude'>, b: Pick<GpsPoint, 'latitude' | 'longitude'>) => {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return (2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h))) / 0.3048;
};

export const holeDistanceFeet = (layout: HoleLayout | undefined) =>
  layout?.tee && layout.basket ? Math.round(feetBetween(layout.tee, layout.basket)) : null;

// Basket minus tee elevation in feet; positive means the basket is uphill.
export const holeElevationFeet = (layout: HoleLayout | undefined) => {
  const teeAltitude = layout?.tee?.altitude;
  const basketAltitude = layout?.basket?.altitude;
  return typeof teeAltitude === 'number' && typeof basketAltitude === 'number' ? Math.round((basketAltitude - teeAltitude) / 0.3048) : null;
};

// Course totals calculated from the mapped holes.
export const courseStats = (course: Course) => {
  const layouts = Array.from({ length: course.holes }, (_, index) => course.layouts?.[index]);
  const mapped = layouts.filter((layout) => layout?.tee && layout.basket);
  const pars = layouts.flatMap((layout) => (layout?.par === undefined ? [] : [layout.par]));
  const altitudes = layouts.flatMap((layout) => [layout?.tee?.altitude, layout?.basket?.altitude]).filter((altitude): altitude is number => typeof altitude === 'number');
  return {
    holes: course.holes,
    mappedHoles: mapped.length,
    par: pars.reduce((sum, par) => sum + par, 0),
    parHoles: pars.length,
    distanceFeet: mapped.reduce((sum, layout) => sum + (holeDistanceFeet(layout) ?? 0), 0),
    elevationFeet: altitudes.length >= 2 ? Math.round((Math.max(...altitudes) - Math.min(...altitudes)) / 0.3048) : null,
  };
};

export const regionAtPoint = (point: Pick<GpsPoint, 'latitude' | 'longitude'>): MapRegion => ({
  latitude: point.latitude,
  longitude: point.longitude,
  latitudeDelta: (MAP_VIEW_WIDTH_FEET * 0.3048) / METERS_PER_DEGREE,
  longitudeDelta: (MAP_VIEW_WIDTH_FEET * 0.3048) / (METERS_PER_DEGREE * Math.max(0.01, Math.cos((point.latitude * Math.PI) / 180))),
});

// Frames every given point with some padding; a single point gets the max-zoom region.
export const regionForPoints = (points: Pick<GpsPoint, 'latitude' | 'longitude'>[]): MapRegion | null => {
  if (!points.length) return null;
  if (points.length === 1) return regionAtPoint(points[0]);
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const minDelta = 60 / METERS_PER_DEGREE;
  return {
    latitude: (Math.min(...latitudes) + Math.max(...latitudes)) / 2,
    longitude: (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
    latitudeDelta: Math.max(minDelta, (Math.max(...latitudes) - Math.min(...latitudes)) * 1.6),
    longitudeDelta: Math.max(minDelta, (Math.max(...longitudes) - Math.min(...longitudes)) * 1.6),
  };
};

export const regionForHole = (layout: HoleLayout | undefined): MapRegion | null => {
  const { tee, basket } = layout ?? { tee: null, basket: null };
  if (!tee || !basket) return tee || basket ? regionAtPoint((tee ?? basket)!) : null;
  const minDelta = 60 / METERS_PER_DEGREE;
  return {
    latitude: (tee.latitude + basket.latitude) / 2,
    longitude: (tee.longitude + basket.longitude) / 2,
    latitudeDelta: Math.max(minDelta, Math.abs(tee.latitude - basket.latitude) * 1.6),
    longitudeDelta: Math.max(minDelta, Math.abs(tee.longitude - basket.longitude) * 1.6),
  };
};
