import type { CourseDetails, DiscInfo, GpsPoint, Lie, SessionArchive, Shot } from '../lib/types';

export const formatLie = (lie: Lie | undefined) => (lie === 'OB' ? 'OB (+1 penalty)' : lie?.toLowerCase());
// Throws logged before the 1-3 scale have no qualityMax and were rated out of 5.
export const formatQuality = (shot: Shot) => (shot.quality ? `${shot.quality}/${shot.qualityMax ?? 5}` : null);

export const formatFlightNumbers = (info: DiscInfo) => `${info.speed} | ${info.glide} | ${info.turn} | ${info.fade}`;

export const formatDiscMeta = (info: DiscInfo) => `${info.brand} · ${formatFlightNumbers(info)}`;

// Session ids are the Date.now() timestamp of when the session started (before rounds synced while
// in progress, of when it ended).
export const formatSessionDate = (session: SessionArchive) => {
  const date = new Date(Number(session.id));
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};

export const formatSyncTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const initialsFor = (name: string) => name.trim().split(/\s+/).map((word) => word[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';

export const errorMessage = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

export const formatScoreToPar = (diff: number) => (diff === 0 ? 'E' : diff > 0 ? `+${diff}` : String(diff));

export const formatThrowDetail = (shot: Shot) => [
  shot.feet ? `${shot.feet} ft` : 'Distance n/a',
  [shot.disc || 'No disc', shot.style?.toLowerCase(), shot.type.toLowerCase()].filter(Boolean).join(' '),
  formatLie(shot.lie),
  formatQuality(shot),
].filter(Boolean).join(' · ');

// Formats US numbers as (555) 123-4567 while typing; numbers starting with + are left as typed.
export const formatPhone = (input: string) => {
  if (input.trim().startsWith('+')) return input;
  let digits = input.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (digits.length <= 3) return digits.length ? `(${digits}` : '';
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
};

export const courseStreet = (course: CourseDetails) => course.street ?? course.address ?? '';

export const courseAddressLine = (course: CourseDetails) =>
  [courseStreet(course), course.city, course.state].map((part) => part?.trim()).filter(Boolean).join(', ');

export const formatSavedPoint = (point: GpsPoint | null | undefined) =>
  point ? (point.accuracy === null ? 'Saved' : `Saved · ±${Math.round(point.accuracy)} m`) : 'Not saved';

export const formatElevation = (feet: number) => (feet > 0 ? `↑ ${feet} ft` : feet < 0 ? `↓ ${-feet} ft` : 'Flat');

export const statFeet = (value: number | null) => (value === null || value === 0 ? '—' : `${Math.round(value).toLocaleString()} ft`);
export const statQuality = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)}/3`);
export const statPercent = (count: number, total: number) => `${Math.round((count / total) * 100)}%`;
