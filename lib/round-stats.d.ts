// Types for round-stats.js, the stats code shared with the website.
import type { HoleLayout, Shot } from './types';

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
export declare function quality(shot: Pick<Shot, 'quality' | 'qualityMax'>): number | null;
export declare function summarizeRounds(rounds: StatsRound[]): RoundSummary;
export declare function summarizeRound(shots: Shot[], layouts?: StatsRound['layouts']): RoundSummary;
export declare function roundScore(shots: Shot[], layouts?: StatsRound['layouts']): { holes: number; strokes: number; toPar: number | null };
