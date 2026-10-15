// Types for round-stats.js, the stats code shared with the website.
import type { GpsPoint, HoleLayout, Shot } from './types';

export type GroupStats = { label: string; count: number; averageFeet: number | null; longestFeet: number | null; averageQuality: number | null };

export type RoundSummary = {
  count: number;
  penalties: number;
  totalFeet: number;
  longest: { feet: number; disc: string; type: string } | null;
  averageQuality: number | null;
  byType: GroupStats[];
  byStyle: GroupStats[];
  byDisc: GroupStats[];
  putting: {
    attempts: number; made: number; hit: number; missed: number;
    // Made putts' distances from the basket; `measured` counts those with a reliable distance.
    madePutts: { averageFeet: number | null; longestFeet: number | null; measured: number };
    firstPutts: { attempts: number; made: number; averageFeet: number | null; measured: number };
  } | null;
  driveCircles: { drives: number; measured: number; c1: number; c2: number };
  landings: { lie: string; count: number }[];
  qualities: { label: string; count: number }[];
};

export type StatsRound = { shots: Shot[]; layouts?: (HoleLayout | null | undefined)[] };

export declare const QUALITY_LABELS: Record<number, string>;
export declare const C1_FEET: number;
export declare const C2_FEET: number;
export declare const POOR_ACCURACY_M: number;
export declare function quality(shot: Pick<Shot, 'quality' | 'qualityMax'>): number | null;
export declare function reliableDistances(rounds: StatsRound[]): Set<Shot>;
export declare function summarizeRounds(rounds: StatsRound[], reliable?: Set<Shot>): RoundSummary;
export declare function summarizeRound(shots: Shot[], layouts?: StatsRound['layouts']): RoundSummary;
export declare function roundScore(shots: Shot[], layouts?: StatsRound['layouts']): { holes: number; strokes: number; toPar: number | null };

export type DriveResult = 'ace' | 'c1' | 'c2' | 'fairway' | 'rough' | 'ob';
export type PuttCount = { made: number; attempts: number };

export type HoleBreakdown = {
  hole: number;
  par: number | null;
  // Tee to basket, when both are mapped.
  lengthFeet: number | null;
  strokes: number;
  driving: DriveResult | null;
  scramble: boolean | null;
  green: 'c1' | 'c2' | 'missed' | null;
  c1x: PuttCount;
  c2: PuttCount;
  throwInFeet: number | null;
  penalties: number;
};

export type ScoringStats = {
  holes: number;
  fairway: { hit: number; drives: number };
  scramble: { saved: number; chances: number };
  // c2 counts holes reaching C2 or better, so it includes the C1 holes.
  greens: { c1: number; c2: number; holes: number };
  c1x: PuttCount;
  c2: PuttCount;
  madePutts: { count: number; totalFeet: number; averageFeet: number | null; longestFeet: number | null };
  penalties: number;
};

export declare const TAP_IN_FEET: number;
export declare function holeBreakdown(shots: Shot[], layouts?: StatsRound['layouts']): HoleBreakdown[];
export declare function scoringStats(rounds: StatsRound[]): ScoringStats;

export type DiscStats = {
  disc: string;
  throws: number;
  // Throws with a reliable distance; the distance figures come from these.
  measured: number;
  minFeet: number | null;
  maxFeet: number | null;
  averageFeet: number | null;
  p90Feet: number | null;
  p95Feet: number | null;
  // As if thrown on flat ground (see FLAT_FEET_PER_FOOT), from the throws whose elevations are known.
  flatMeasured: number;
  flatAverageFeet: number | null;
  quality: { good: number; fair: number; poor: number; unrated: number };
  averageQuality: number | null;
};

export declare function percentile(sorted: number[], fraction: number): number | null;
// Ground elevations in metres by groundKey (null where unknown), for flat-ground distances.
export type GroundElevations = Map<string, number | null>;
export declare const FLAT_FEET_PER_FOOT: number;
export declare function groundKey(point: { latitude: number; longitude: number }): string;
export declare function groundPoints(rounds: StatsRound[]): { latitude: number; longitude: number }[];
export declare function discStats(rounds: StatsRound[], options?: { types?: string[]; ground?: GroundElevations }): DiscStats[];

// flatFeet: the distance as if thrown on flat ground; riseFeet: how far it climbed (negative for a drop).
export type DiscThrow<R extends StatsRound = StatsRound> = { round: R; shot: Shot; feet: number | null; flatFeet: number | null; riseFeet: number | null };
export declare function discThrows<R extends StatsRound>(rounds: R[], disc: string, options?: { types?: string[]; ground?: GroundElevations }): DiscThrow<R>[];

export declare function parsToSave(shots: Pick<Shot, 'hole'>[], layouts?: StatsRound['layouts'], saved?: (number | null)[]): (number | null)[] | undefined;
export declare function roundLayouts(layouts: StatsRound['layouts'] | undefined, pars: (number | null)[] | undefined): (HoleLayout | null | undefined)[];

type Point = { latitude: number; longitude: number };
export declare function remeasureHole(shots: Shot[], hole: number, tee: Point | null | undefined): Shot[];
export declare function placedPoint(latitude: number, longitude: number, now: number): GpsPoint;
export declare function moveThrow(shots: Shot[], index: number, latitude: number, longitude: number, tee: Point | null | undefined): Shot[];
