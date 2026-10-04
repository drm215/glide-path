import type { Disc, Lie, ThrowStyle, ThrowType } from '../lib/types';

// Wait this long after the last edit before syncing, so a burst of edits uploads once.
export const SYNC_DEBOUNCE_MS = 4_000;
export const DISCIT_API_URL = 'https://discit-api.fly.dev/disc';
export const DISC_SEARCH_MIN_CHARS = 2;
export const DISC_SEARCH_MAX_RESULTS = 12;
// Placeholder discs from earlier versions; removed from saved bags on load.
export const LEGACY_DEFAULT_DISCS: Disc[] = ['Distance', 'Fairway', 'Midrange', 'Putter'];
export const TYPE_OPTIONS: ThrowType[] = ['Drive', 'Approach', 'Putt'];
export const PAR_OPTIONS = [2, 3, 4, 5, 6];
export const STYLE_OPTIONS: ThrowStyle[] = ['Backhand', 'Forehand', 'Spike hyzer', 'Roller', 'Tomahawk', 'Thumber', 'Recovery', 'Other'];
export const LIE_OPTIONS: Lie[] = ['Fairway', 'Woods', 'Hazard', 'OB', 'Basket', 'Other'];
// Putts ask for a result instead of a landing spot.
export const PUTT_RESULT_OPTIONS: Lie[] = ['Basket', 'Hit basket', 'Missed', 'OB'];
export const lieOptionsFor = (type: ThrowType) => (type === 'Putt' ? PUTT_RESULT_OPTIONS : LIE_OPTIONS);
export const lieLabel = (lie: Lie, type: ThrowType) => (lie === 'Basket' && type === 'Putt' ? 'Made' : lie);

// During a round the screen stays on and is dimmed to this brightness (0-1), and every button
// needs a deliberate hold, so the phone can stay out without unlocking or stray taps.
// iOS restores the user's brightness when the phone locks.
export const ROUND_BRIGHTNESS = 0.3;
// GPS accuracy (meters) good enough to log a throw without taking a fresh reading, and the point
// past which the throw sheet warns that its distance is unreliable.
export const GPS_GOOD_ACCURACY_M = 8;
export const GPS_POOR_ACCURACY_M = 15;
// How old the round screen's warm GPS fix can be and still be used for a throw.
export const WARM_FIX_MAX_AGE_MS = 5_000;
export const ROUND_KEEP_AWAKE_TAG = 'round-in-progress';
export const HOLD_DELAY_MS = 400;
// The throw editor's id for the round in progress (past rounds use their own ids).
export const ACTIVE_SESSION_ID = '__active__';

export const OB_PENALTY_STROKES = 1;

export const QUALITY_OPTIONS = [
  { value: 1, label: 'Poor' },
  { value: 2, label: 'Fair' },
  { value: 3, label: 'Good' },
];
export const QUALITY_MAX = QUALITY_OPTIONS.length;

export const RESULT_TYPES = [
  { label: 'Eagle or better', matches: (diff: number) => diff <= -2 },
  { label: 'Birdie', matches: (diff: number) => diff === -1 },
  { label: 'Par', matches: (diff: number) => diff === 0 },
  { label: 'Bogey', matches: (diff: number) => diff === 1 },
  { label: 'Double bogey+', matches: (diff: number) => diff >= 2 },
];

export const FILTER_TYPES: ThrowType[] = ['Drive', 'Approach', 'Putt'];
