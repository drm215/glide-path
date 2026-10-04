import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as Brightness from 'expo-brightness';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import MapView, { Circle, Marker, Polyline } from 'react-native-maps';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Linking,
  Modal,
  Image,
  Pressable,
  type PressableProps,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  API_URL,
  ApiError,
  courseShareUrl,
  deleteAccount as deleteAccountRequest,
  getPublicCourse,
  register as registerRequest,
  requestPasswordReset,
  resetPassword,
  roundShareUrl,
  searchCourses,
  signIn as signInRequest,
  syncWithServer,
  type PublicCourse,
  type PublicCourseSummary,
} from './lib/api';
import { guessDisc, guessThrowType, placeMadeThrowsAtBasket, remeasureHole, suggestDiscs } from './lib/rounds';
import { quality as qualityOf, QUALITY_LABELS as QUALITY_NAMES, roundScore as statsRoundScore, summarizeRounds, type GroupStats, type StatsRound } from './lib/round-stats';
import { buildSyncRequest, clearSentTombstones, countPendingChanges, initialBagUpdatedAt, mergeCourses, mergeRounds, sendInBatches, type SyncAccount, type SyncData } from './lib/sync';
import { MAIN_LAYOUT_ID, courseLayouts, layoutDisplayName, updateLayoutIn, withExistingLayout, withLayout, type CourseView } from './lib/layouts';
import type { Course, CourseDetails, CourseLayout, Disc, DiscInfo, GpsPoint, HoleLayout, Lie, SessionArchive, Shot, ThrowStyle, ThrowType, Tombstone } from './lib/types';

// A past round reopened as the round in progress keeps its id, so ending it again updates it.
type ResumedFrom = { id: string; shared?: boolean; shareToken?: string | null };
type SavedRound = {
  // history is only read, from devices that saved it here before HISTORY_KEY existed.
  shots: Shot[]; hole: number; mode: 'Round' | 'Practice'; history?: SessionArchive[]; courseId?: string; active?: boolean; practiceFocus?: string;
  layoutId?: string; resumedFrom?: ResumedFrom | null;
};
type LastAccount = { id: string; email: string; pushedThrough: number };
type Screen = 'Home' | 'CourseBuilder' | 'HoleWizard' | 'BagBuilder' | 'Practice' | 'Round' | 'Insights' | 'Rounds' | 'RoundDetail' | 'Account' | 'FindCourses' | 'NewCourse';
type MapRegion = { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };

// Keys keep the app's original name (Flight Notes) so existing on-device data still loads.
// The round in progress. Past sessions were once stored here too (SavedRound.history).
const STORAGE_KEY = 'flight-notes-round-v1';
// Past sessions, kept apart from the round in progress so logging a throw doesn't rewrite them all.
const HISTORY_KEY = 'flight-notes-history-v1';
const COURSES_KEY = 'flight-notes-courses-v1';
const BAG_KEY = 'flight-notes-bag-v1';
const BAG_DETAILS_KEY = 'flight-notes-bag-details-v1';
const BAG_WEIGHTS_KEY = 'flight-notes-bag-weights-v1';
// One-time data fixes that have already run on this device.
const MIGRATIONS_KEY = 'flight-notes-migrations-v1';
// Sync account (without its token) and pending sync bookkeeping.
const SYNC_KEY = 'flight-notes-sync-v1';
const SYNC_META_KEY = 'flight-notes-sync-meta-v1';
// The account this phone's data was last synced with. Kept after signing out, so signing in to
// a different account can ask before uploading this data into it.
const LAST_ACCOUNT_KEY = 'flight-notes-last-account-v1';
// The sign-in token lives in the iOS Keychain rather than plain app storage.
const TOKEN_KEY = 'glide-path-token';

// Keys whose stored value couldn't be read or backed up at launch. Saving to them would
// overwrite the only copy, so they're left alone until the next launch.
const unsaveableKeys = new Set<string>();
let saveFailureShown = false;

// Writes a value to app storage, telling the user (once per launch) if storage is failing.
const saveToStorage = (key: string, value: unknown) => {
  if (unsaveableKeys.has(key)) return;
  AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {
    if (saveFailureShown) return;
    saveFailureShown = true;
    Alert.alert('Could not save', 'Your latest changes couldn’t be saved on this phone. Free up some storage space, then reopen Glide Path.');
  });
};
// Wait this long after the last edit before syncing, so a burst of edits uploads once.
const SYNC_DEBOUNCE_MS = 4_000;
const DISCIT_API_URL = 'https://discit-api.fly.dev/disc';
const DISC_SEARCH_MIN_CHARS = 2;
const DISC_SEARCH_MAX_RESULTS = 12;
// Dark, low-glare theme: black background, soft light text, muted green accents.
const INK = '#d6ddd8';
const MUTED = '#7d8981';
const GREEN = '#3a8f68';
const PAPER = '#000000';
// Deliberately tighter than any map can render; the map clamps to its maximum zoom level.
const MAP_VIEW_WIDTH_FEET = 20;
const MAP_SCALE_BAR_OPTIONS_FEET = [5, 10, 25, 50, 100];
const METERS_PER_DEGREE = 111_320;
const EARTH_RADIUS_METERS = 6_371_000;
// Placeholder discs from earlier versions; removed from saved bags on load.
const LEGACY_DEFAULT_DISCS: Disc[] = ['Distance', 'Fairway', 'Midrange', 'Putter'];
const TYPE_OPTIONS: ThrowType[] = ['Drive', 'Approach', 'Putt'];
const PAR_OPTIONS = [2, 3, 4, 5, 6];
const STYLE_OPTIONS: ThrowStyle[] = ['Backhand', 'Forehand', 'Spike hyzer', 'Roller', 'Tomahawk', 'Thumber', 'Recovery', 'Other'];
const LIE_OPTIONS: Lie[] = ['Fairway', 'Woods', 'Hazard', 'OB', 'Basket', 'Other'];
// Putts ask for a result instead of a landing spot.
const PUTT_RESULT_OPTIONS: Lie[] = ['Basket', 'Hit basket', 'Missed', 'OB'];
const lieOptionsFor = (type: ThrowType) => (type === 'Putt' ? PUTT_RESULT_OPTIONS : LIE_OPTIONS);
const lieLabel = (lie: Lie, type: ThrowType) => (lie === 'Basket' && type === 'Putt' ? 'Made' : lie);

// During a round the screen stays on and is dimmed to this brightness (0-1), and every button
// needs a deliberate hold, so the phone can stay out without unlocking or stray taps.
// iOS restores the user's brightness when the phone locks.
const ROUND_BRIGHTNESS = 0.3;
const ROUND_KEEP_AWAKE_TAG = 'round-in-progress';
const HOLD_DELAY_MS = 400;
// The throw editor's id for the round in progress (past rounds use their own ids).
const ACTIVE_SESSION_ID = '__active__';

// The next throw on a hole: a drive to start, a putt after a putt, otherwise an approach.
const nextThrowType = (holeShots: Shot[]): ThrowType => {
  const last = holeShots.at(-1);
  return !last ? 'Drive' : last.type === 'Putt' ? 'Putt' : 'Approach';
};
const OB_PENALTY_STROKES = 1;

// Score for a list of throws: every throw counts, plus a penalty stroke for each one out of bounds.
const countStrokes = (list: Shot[]) => list.length + list.filter((shot) => shot.lie === 'OB').length * OB_PENALTY_STROKES;

const formatLie = (lie: Lie | undefined) => (lie === 'OB' ? 'OB (+1 penalty)' : lie?.toLowerCase());
const QUALITY_OPTIONS = [
  { value: 1, label: 'Poor' },
  { value: 2, label: 'Fair' },
  { value: 3, label: 'Good' },
];
const QUALITY_MAX = QUALITY_OPTIONS.length;
// Throws logged before the 1-3 scale have no qualityMax and were rated out of 5.
const formatQuality = (shot: Shot) => (shot.quality ? `${shot.quality}/${shot.qualityMax ?? 5}` : null);

const isGpsPoint = (point: unknown): point is GpsPoint => {
  if (!point || typeof point !== 'object') return false;
  const candidate = point as Partial<GpsPoint>;
  return typeof candidate.latitude === 'number' && typeof candidate.longitude === 'number';
};

const formatFlightNumbers = (info: DiscInfo) => `${info.speed} | ${info.glide} | ${info.turn} | ${info.fade}`;

const formatDiscMeta = (info: DiscInfo) => `${info.brand} · ${formatFlightNumbers(info)}`;

// Archive ids are the Date.now() timestamp of when the session ended.
const formatSessionDate = (session: SessionArchive) => {
  const date = new Date(Number(session.id));
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};

// Session ids are the timestamp of when the session ended (see formatSessionDate).
const newSessionId = () => String(Date.now());

// Edit times for sync. Kept outside the component so render stays pure.
const nowMs = () => Date.now();

const formatSyncTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const initialsFor = (name: string) => name.trim().split(/\s+/).map((word) => word[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';

const errorMessage = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

const RESULT_TYPES = [
  { label: 'Eagle or better', matches: (diff: number) => diff <= -2 },
  { label: 'Birdie', matches: (diff: number) => diff === -1 },
  { label: 'Par', matches: (diff: number) => diff === 0 },
  { label: 'Bogey', matches: (diff: number) => diff === 1 },
  { label: 'Double bogey+', matches: (diff: number) => diff >= 2 },
];

const formatScoreToPar = (diff: number) => (diff === 0 ? 'E' : diff > 0 ? `+${diff}` : String(diff));

// Score for a set of throws. A hole counts toward par once it's complete: it has a
// basket throw, or it isn't the hole currently being played.
const scoreSummary = (sessionShots: Shot[], course: Course | undefined, currentHole?: number) => {
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

const formatThrowDetail = (shot: Shot) => [
  shot.feet ? `${shot.feet} ft` : 'Distance n/a',
  [shot.disc || 'No disc', shot.style?.toLowerCase(), shot.type.toLowerCase()].filter(Boolean).join(' '),
  formatLie(shot.lie),
  formatQuality(shot),
].filter(Boolean).join(' · ');

// Formats US numbers as (555) 123-4567 while typing; numbers starting with + are left as typed.
const formatPhone = (input: string) => {
  if (input.trim().startsWith('+')) return input;
  let digits = input.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  digits = digits.slice(0, 10);
  if (digits.length <= 3) return digits.length ? `(${digits}` : '';
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
};

const courseStreet = (course: CourseDetails) => course.street ?? course.address ?? '';

const courseAddressLine = (course: CourseDetails) =>
  [courseStreet(course), course.city, course.state].map((part) => part?.trim()).filter(Boolean).join(', ');

const formatSavedPoint = (point: GpsPoint | null | undefined) =>
  point ? (point.accuracy === null ? 'Saved' : `Saved · ±${Math.round(point.accuracy)} m`) : 'Not saved';

const feetBetween = (a: Pick<GpsPoint, 'latitude' | 'longitude'>, b: Pick<GpsPoint, 'latitude' | 'longitude'>) => {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return (2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h))) / 0.3048;
};

const holeDistanceFeet = (layout: HoleLayout | undefined) =>
  layout?.tee && layout.basket ? Math.round(feetBetween(layout.tee, layout.basket)) : null;

// Basket minus tee elevation in feet; positive means the basket is uphill.
const holeElevationFeet = (layout: HoleLayout | undefined) => {
  const teeAltitude = layout?.tee?.altitude;
  const basketAltitude = layout?.basket?.altitude;
  return typeof teeAltitude === 'number' && typeof basketAltitude === 'number' ? Math.round((basketAltitude - teeAltitude) / 0.3048) : null;
};

const formatElevation = (feet: number) => (feet > 0 ? `↑ ${feet} ft` : feet < 0 ? `↓ ${-feet} ft` : 'Flat');

// Course totals calculated from the mapped holes.
const courseStats = (course: Course) => {
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

const regionAtPoint = (point: Pick<GpsPoint, 'latitude' | 'longitude'>): MapRegion => ({
  latitude: point.latitude,
  longitude: point.longitude,
  latitudeDelta: (MAP_VIEW_WIDTH_FEET * 0.3048) / METERS_PER_DEGREE,
  longitudeDelta: (MAP_VIEW_WIDTH_FEET * 0.3048) / (METERS_PER_DEGREE * Math.max(0.01, Math.cos((point.latitude * Math.PI) / 180))),
});

// C1 (10 m) and C2 (20 m) putting circles drawn around a basket.
const BasketCircles = ({ basket }: { basket: Pick<GpsPoint, 'latitude' | 'longitude'> }) => (
  <>
    <Circle center={basket} radius={20} strokeColor="rgba(255,255,255,0.7)" strokeWidth={1.5} fillColor="rgba(255,255,255,0.06)" />
    <Circle center={basket} radius={10} strokeColor="rgba(255,255,255,0.9)" strokeWidth={1.5} fillColor="rgba(255,255,255,0.1)" />
  </>
);

// Frames the tee and basket together with some padding; falls back to max zoom on a single point.
// Frames every given point with some padding; a single point gets the max-zoom region.
const regionForPoints = (points: Pick<GpsPoint, 'latitude' | 'longitude'>[]): MapRegion | null => {
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

const regionForHole = (layout: HoleLayout | undefined): MapRegion | null => {
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

const statFeet = (value: number | null) => (value === null || value === 0 ? '—' : `${Math.round(value).toLocaleString()} ft`);
const statQuality = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)}/3`);
const statPercent = (count: number, total: number) => `${Math.round((count / total) * 100)}%`;

const StatTile = ({ label, value, note }: { label: string; value: string | number; note?: string | null }) => (
  <View style={styles.courseStat}>
    <Text style={styles.statLabel}>{label}</Text>
    <Text style={styles.courseStatValue}>{value}</Text>
    {note ? <Text style={styles.courseStatNote}>{note}</Text> : null}
  </View>
);

const GroupTable = ({ heading, rows }: { heading: string; rows: GroupStats[] }) => (
  <View style={styles.statTable}>
    <View style={[styles.statTableRow, styles.statTableHead]}>
      {[heading, 'THROWS', 'AVG', 'LONGEST', 'QUALITY'].map((label, index) => <Text key={label} style={[index ? styles.statCell : styles.statCellName, styles.statHeadText]}>{label}</Text>)}
    </View>
    {rows.map((row) => <View key={row.label} style={styles.statTableRow}>
      <Text style={styles.statCellName} numberOfLines={1}>{row.label}</Text>
      <Text style={styles.statCell}>{row.count}</Text>
      <Text style={styles.statCell}>{statFeet(row.averageFeet)}</Text>
      <Text style={styles.statCell}>{statFeet(row.longestFeet)}</Text>
      <Text style={styles.statCell}>{statQuality(row.averageQuality)}</Text>
    </View>)}
  </View>
);

const FILTER_TYPES: ThrowType[] = ['Drive', 'Approach', 'Putt'];

// Throw stats for one or many rounds, matching the website's round summary. Each round brings
// the hole layouts it was played on, for first-putt distances and drive circles.
const StatsSummary = ({ title, rounds, scope }: { title: string; rounds: StatsRound[]; scope: string }) => {
  const [discType, setDiscType] = useState<ThrowType | null>(null);
  const [discQuality, setDiscQuality] = useState<number | null>(null);
  const shots = rounds.flatMap((round) => round.shots);
  if (!shots.length) return null;
  const summary = summarizeRounds(rounds);
  const { putting, driveCircles } = summary;
  const types = FILTER_TYPES.filter((type) => shots.some((shot) => shot.type === type));
  const ratings = [3, 2, 1].filter((value) => shots.some((shot) => qualityOf(shot) === value));
  const discShots = shots.filter((shot) => (discType === null || shot.type === discType) && (discQuality === null || qualityOf(shot) === discQuality));
  const filterChip = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} style={[styles.chip, selected && styles.chipSelected]} accessibilityRole="button" accessibilityState={{ selected }}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.statsSection}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.courseStatsGrid}>
        <StatTile label="THROWS" value={summary.count} note={summary.penalties === 1 ? '1 OB penalty' : summary.penalties ? `${summary.penalties} OB penalties` : 'No penalties'} />
        <StatTile label="TOTAL DISTANCE" value={statFeet(summary.totalFeet)} note="Measured by GPS" />
        <StatTile label="LONGEST" value={statFeet(summary.longest?.feet ?? null)} note={summary.longest ? `${summary.longest.disc} ${summary.longest.type.toLowerCase()}` : null} />
        <StatTile label="AVG QUALITY" value={statQuality(summary.averageQuality)} note={summary.qualities.length ? null : 'Not rated'} />
      </View>
      <Text style={styles.statsHeading}>By throw type</Text>
      <GroupTable heading="TYPE" rows={summary.byType} />
      {summary.byStyle.length > 0 && <><Text style={styles.statsHeading}>By throw style</Text><GroupTable heading="STYLE" rows={summary.byStyle} /></>}
      {putting && <>
        <Text style={styles.statsHeading}>Putting</Text>
        <View style={styles.courseStatsGrid}>
          <StatTile label="FIRST-PUTT MAKES" value={statPercent(putting.firstPutts.made, putting.firstPutts.attempts)} note={`${putting.firstPutts.made} of ${putting.firstPutts.attempts} holes`} />
          <StatTile label="AVG FIRST PUTT" value={statFeet(putting.firstPutts.averageFeet)} note={putting.firstPutts.measured < putting.firstPutts.attempts ? `${putting.firstPutts.measured} of ${putting.firstPutts.attempts} measured` : 'From lie to basket'} />
          <StatTile label="ALL PUTTS" value={statPercent(putting.made, putting.attempts)} note={`${putting.made} of ${putting.attempts} made`} />
          <StatTile label="MISSES" value={putting.hit + putting.missed} note={`${putting.hit} hit the basket · ${putting.missed} missed`} />
        </View>
      </>}
      {driveCircles.drives > 0 && <>
        <Text style={styles.statsHeading}>Drives in the circles</Text>
        {driveCircles.measured ? <View style={styles.courseStatsGrid}>
          <StatTile label="IN C1" value={statPercent(driveCircles.c1, driveCircles.measured)} note={`${driveCircles.c1} of ${driveCircles.measured} · within 33 ft`} />
          <StatTile label="IN C2" value={statPercent(driveCircles.c2, driveCircles.measured)} note={`${driveCircles.c2} of ${driveCircles.measured} · 33–66 ft`} />
          <StatTile label="INSIDE C2" value={statPercent(driveCircles.c1 + driveCircles.c2, driveCircles.measured)} note={`${driveCircles.c1 + driveCircles.c2} of ${driveCircles.measured} drives`} />
          <StatTile label="MEASURED" value={`${driveCircles.measured}/${driveCircles.drives}`} note="Need a logged spot and mapped basket" />
        </View> : <Text style={styles.mapInstruction}>Circle hits need a drive’s logged landing spot and the hole’s mapped basket, and no drive in {scope} has both.</Text>}
      </>}
      <Text style={styles.statsHeading}>By disc</Text>
      {types.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {[filterChip('All throws', discType === null, () => setDiscType(null)), ...types.map((type) => filterChip(type, discType === type, () => setDiscType(type)))]}
      </ScrollView>}
      {ratings.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {[filterChip('Any quality', discQuality === null, () => setDiscQuality(null)), ...ratings.map((value) => filterChip(QUALITY_NAMES[value], discQuality === value, () => setDiscQuality(value)))]}
      </ScrollView>}
      {discShots.length ? <GroupTable heading="DISC" rows={summarizeRounds([{ shots: discShots }]).byDisc} /> : <Text style={styles.mapInstruction}>No throws match these filters.</Text>}
      {summary.landings.length > 0 && <>
        <Text style={styles.statsHeading}>Where throws landed</Text>
        <Text style={styles.statsChips}>{summary.landings.map((item) => `${item.lie === 'Basket' ? 'In the basket' : item.lie} ${item.count}`).join('  ·  ')}</Text>
      </>}
      {summary.qualities.length > 0 && <>
        <Text style={styles.statsHeading}>Throw quality</Text>
        <Text style={styles.statsChips}>{summary.qualities.map((item) => `${item.label} ${item.count}`).join('  ·  ')}</Text>
      </>}
    </View>
  );
};

// A button that only responds to a press-and-hold, with a light buzz when the hold registers.
// Used during a round so that bumps and stray taps never act.
const HoldPressable = ({ onPress, style, children, ...rest }: Omit<PressableProps, 'onPress' | 'onLongPress'> & { onPress?: () => void }) => (
  <Pressable
    {...rest}
    delayLongPress={HOLD_DELAY_MS}
    onLongPress={() => {
      Haptics.selectionAsync().catch(() => undefined);
      onPress?.();
    }}
    style={(state) => [typeof style === 'function' ? style(state) : style, state.pressed && holdStyles.holding]}
  >
    {children}
  </Pressable>
);

const holdStyles = StyleSheet.create({ holding: { opacity: 0.55 } });

export default function App() {
  const { width } = useWindowDimensions();
  const compact = width < 390;
  const [screen, setScreen] = useState<Screen>('Home');
  const [mode, setMode] = useState<'Round' | 'Practice'>('Round');
  const [hole, setHole] = useState(4);
  const [shots, setShots] = useState<Shot[]>([]);
  const [history, setHistory] = useState<SessionArchive[]>([]);
  const [disc, setDisc] = useState<Disc>('');
  const [bag, setBag] = useState<Disc[]>([]);
  const [bagEntry, setBagEntry] = useState('');
  const [bagDetails, setBagDetails] = useState<Record<Disc, DiscInfo>>({});
  // Disc weights in grams, keyed by disc name.
  const [bagWeights, setBagWeights] = useState<Record<Disc, number>>({});
  const [discSearch, setDiscSearch] = useState<{ query: string; results: DiscInfo[]; failed: boolean }>({ query: '', results: [], failed: false });
  const [courses, setCourses] = useState<Course[]>([{ id: 'pine-ridge', name: 'Pine Ridge (Sample)', holes: 18, layouts: Array.from({ length: 18 }, () => ({ tee: null, basket: null })) }]);
  const [selectedCourseId, setSelectedCourseId] = useState('pine-ridge');
  const [courseName, setCourseName] = useState('');
  const [builderHole, setBuilderHole] = useState(1);
  const [savingGpsTarget, setSavingGpsTarget] = useState<'tee' | 'basket' | null>(null);
  const [gpsMessage, setGpsMessage] = useState('');
  const [mapRegion, setMapRegion] = useState<MapRegion | null>(null);
  const [mapViewportWidth, setMapViewportWidth] = useState(0);
  const [locationAllowed, setLocationAllowed] = useState(false);
  const [mapLoading, setMapLoading] = useState(false);
  const [practiceFocus, setPracticeFocus] = useState('Distance');
  const [sessionActive, setSessionActive] = useState(false);
  const [viewedSessionId, setViewedSessionId] = useState<string | null>(null);
  const [showCourseInfo, setShowCourseInfo] = useState(false);
  const [showingRoundSummary, setShowingRoundSummary] = useState(false);
  const [expandedHole, setExpandedHole] = useState<number | null>(null);
  const roundDetailScrollRef = useRef<ScrollView>(null);
  const holeSectionOffsets = useRef<Record<number, number>>({});
  const roundScrollRef = useRef<ScrollView>(null);

  // Bring the hole number and map back into view whenever the hole changes.
  useEffect(() => {
    roundScrollRef.current?.scrollTo({ y: 0, animated: true });
  }, [hole]);
  const [throwType, setThrowType] = useState<ThrowType>('Drive');
  const [loggingThrow, setLoggingThrow] = useState(false);
  const [roundMessage, setRoundMessage] = useState('');
  const [pendingLie, setPendingLie] = useState<{ latitude: number; longitude: number; altitude: number | null; feet: number } | null>(null);
  const [logStep, setLogStep] = useState<1 | 2 | 3 | 4>(1);
  const [throwLie, setThrowLie] = useState<Lie>('Fairway');
  // The last style used is the default for the next throw.
  const [throwStyle, setThrowStyle] = useState<ThrowStyle>('Backhand');
  const savedBrightness = useRef<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [account, setAccount] = useState<SyncAccount | null>(null);
  const lastAccount = useRef<LastAccount | null>(null);
  const [bagUpdatedAt, setBagUpdatedAt] = useState(0);
  const [deletedCourses, setDeletedCourses] = useState<Tombstone[]>([]);
  const [deletedRounds, setDeletedRounds] = useState<Tombstone[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  // 'forgot' asks for the email to send a reset code to; 'reset' takes the code and a new password.
  const [authMode, setAuthMode] = useState<'signIn' | 'register' | 'forgot' | 'reset'>('signIn');
  const [resetCode, setResetCode] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [findQuery, setFindQuery] = useState('');
  const [findResults, setFindResults] = useState<PublicCourseSummary[] | null>(null);
  const [findBusy, setFindBusy] = useState(false);
  const [findError, setFindError] = useState('');
  const [findNearby, setFindNearby] = useState(false);
  const [publicCourse, setPublicCourse] = useState<PublicCourse | null>(null);
  const [publicCourseLoading, setPublicCourseLoading] = useState<string | null>(null);
  const syncInFlight = useRef(false);
  const [selectedLayoutId, setSelectedLayoutId] = useState(MAIN_LAYOUT_ID);
  const [roundPickerOpen, setRoundPickerOpen] = useState(false);
  // The course whose layouts the round picker is showing; null while choosing the course.
  const [roundPickerCourseId, setRoundPickerCourseId] = useState<string | null>(null);
  const [resumedFrom, setResumedFrom] = useState<ResumedFrom | null>(null);
  const [newLayoutName, setNewLayoutName] = useState('');
  // Stats screen filters: a course key ('all', a course id, or name:<course name>) and practice.
  const [statsCourse, setStatsCourse] = useState('all');
  const [statsPractice, setStatsPractice] = useState(false);
  // New-course flow: 1 name, 2 details, 3 layouts, 4 map holes. The course is created after step 1.
  const [newCourseStep, setNewCourseStep] = useState<1 | 2 | 3 | 4>(1);
  const [newCourseId, setNewCourseId] = useState<string | null>(null);
  // Where the hole-mapping screen returns to.
  const [wizardReturn, setWizardReturn] = useState<'CourseBuilder' | 'NewCourse'>('CourseBuilder');
  const [editingThrow, setEditingThrow] = useState<{ sessionId: string; index: number } | null>(null);
  const [throwDraft, setThrowDraft] = useState<{ disc: Disc; type: ThrowType; style?: ThrowStyle; lie: Lie; quality: number | null }>({ disc: '', type: 'Drive', lie: 'Fairway', quality: null });

  useEffect(() => {
    // Each stored value is read on its own, so one that can't be read doesn't stop the rest from
    // loading. The app will save over it, so its raw text is first copied to a backup key.
    const load = async () => {
      const keys = [STORAGE_KEY, HISTORY_KEY, COURSES_KEY, BAG_KEY, BAG_DETAILS_KEY, BAG_WEIGHTS_KEY, SYNC_KEY, SYNC_META_KEY, MIGRATIONS_KEY, LAST_ACCOUNT_KEY];
      const stored: Record<string, string | null> = Object.fromEntries(await AsyncStorage.multiGet(keys));
      const token = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
      const backups: Promise<void>[] = [];
      const read = <T,>(key: string, apply: (value: T) => void) => {
        const raw = stored[key];
        if (raw == null) return;
        try {
          apply(JSON.parse(raw) as T);
        } catch {
          backups.push(AsyncStorage.setItem(`${key}-unreadable-${nowMs()}`, raw).catch(() => {
            unsaveableKeys.add(key);
          }));
        }
      };

      // One-time fix: throws that went in were once recorded where the player stood; move them
      // to the basket. Fixed past rounds get a fresh edit time so the fix syncs everywhere.
      let migrations: Record<string, boolean> = {};
      read<Record<string, boolean>>(MIGRATIONS_KEY, (value) => { migrations = value; });
      const fixMadeThrows = !migrations.madeThrowsAtBasket;

      let storedCourses: Course[] = [];
      read<Course[]>(COURSES_KEY, (value) => {
        storedCourses = value.map((course) => {
          const previousLayouts = course.layouts as { tee?: unknown; basket?: unknown; par?: unknown }[] | undefined;
          return {
            ...course,
            layouts: Array.from({ length: course.holes }, (_, index) => {
              const previous = previousLayouts?.[index];
              return { tee: isGpsPoint(previous?.tee) ? previous.tee : null, basket: isGpsPoint(previous?.basket) ? previous.basket : null, par: typeof previous?.par === 'number' ? previous.par : undefined };
            }),
          };
        });
        setCourses(storedCourses);
      });
      const layoutsFor = (courseId: string | undefined, layoutId: string | undefined) => {
        const course = storedCourses.find((item) => item.id === courseId);
        return course ? withExistingLayout(course, layoutId)?.layouts : undefined;
      };
      const fixSession = (session: SessionArchive): SessionArchive => {
        const fixed = placeMadeThrowsAtBasket(session.shots, layoutsFor(session.courseId, session.layoutId));
        return fixed === session.shots ? session : { ...session, shots: fixed, updatedAt: nowMs() };
      };

      let savedRound = undefined as SavedRound | undefined;
      read<SavedRound>(STORAGE_KEY, (saved) => {
        const activeShots = saved.shots.map((shot) => ({ ...shot, hole: shot.hole ?? saved.hole, courseId: shot.courseId ?? saved.courseId }));
        setShots(fixMadeThrows ? placeMadeThrowsAtBasket(activeShots, layoutsFor(saved.courseId, saved.layoutId)) : activeShots);
        setHole(saved.hole);
        setMode(saved.mode);
        setSelectedLayoutId(saved.layoutId ?? MAIN_LAYOUT_ID);
        setResumedFrom(saved.resumedFrom ?? null);
        // Rounds saved before `active` existed count as in progress if they have throws.
        setSessionActive(saved.active ?? saved.shots.length > 0);
        if (saved.practiceFocus) setPracticeFocus(saved.practiceFocus);
        savedRound = saved;
      });
      const courseToSelect = storedCourses.find((course) => course.id === savedRound?.courseId) ?? storedCourses[0];
      if (courseToSelect) setSelectedCourseId(courseToSelect.id);

      // Past sessions used to be saved with the round in progress. Moving them to their own key
      // has to succeed before the round in progress is saved without them.
      let storedHistory = savedRound?.history ?? [];
      if (stored[HISTORY_KEY] == null && storedHistory.length) {
        await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(storedHistory));
      }
      read<SessionArchive[]>(HISTORY_KEY, (value) => { storedHistory = value; });
      setHistory(fixMadeThrows ? storedHistory.map(fixSession) : storedHistory);

      let savedBagCount = 0;
      read<Disc[]>(BAG_KEY, (value) => {
        const savedBag = value.filter((item) => !LEGACY_DEFAULT_DISCS.includes(item));
        setBag(savedBag);
        if (savedBag.length) setDisc(savedBag[0]);
        savedBagCount = savedBag.length;
      });
      read<Record<Disc, DiscInfo>>(BAG_DETAILS_KEY, setBagDetails);
      read<Record<Disc, number>>(BAG_WEIGHTS_KEY, setBagWeights);
      if (fixMadeThrows) AsyncStorage.setItem(MIGRATIONS_KEY, JSON.stringify({ ...migrations, madeThrowsAtBasket: true })).catch(() => undefined);
      if (token) read<Omit<SyncAccount, 'token'>>(SYNC_KEY, (value) => setAccount({ ...value, token }));
      read<LastAccount>(LAST_ACCOUNT_KEY, (value) => { lastAccount.current = value; });
      let meta: { bagUpdatedAt?: number; deletedCourses?: Tombstone[]; deletedRounds?: Tombstone[] } = {};
      read<typeof meta>(SYNC_META_KEY, (value) => { meta = value; });
      setDeletedCourses(meta.deletedCourses ?? []);
      setDeletedRounds(meta.deletedRounds ?? []);
      setBagUpdatedAt(initialBagUpdatedAt(meta.bagUpdatedAt, savedBagCount, nowMs()));
      await Promise.all(backups);
    };
    // If storage can't be read at all, nothing is saved: saving would replace the user's data
    // with an empty app.
    load().then(
      () => setLoaded(true),
      () => Alert.alert('Could not load your data', 'Glide Path couldn’t read its storage on this phone. Close and reopen the app. Nothing will be saved until your data loads.'),
    );
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const saved: SavedRound = { shots, hole, mode, courseId: selectedCourseId, active: sessionActive, practiceFocus, layoutId: selectedLayoutId, resumedFrom };
    saveToStorage(STORAGE_KEY, saved);
  }, [hole, loaded, mode, practiceFocus, resumedFrom, selectedCourseId, selectedLayoutId, sessionActive, shots]);

  useEffect(() => {
    if (!loaded) return;
    saveToStorage(HISTORY_KEY, history);
  }, [history, loaded]);

  useEffect(() => {
    if (!loaded) return;
    saveToStorage(COURSES_KEY, courses);
  }, [courses, loaded]);

  useEffect(() => {
    if (!loaded) return;
    saveToStorage(BAG_KEY, bag);
  }, [bag, loaded]);

  useEffect(() => {
    if (!loaded) return;
    saveToStorage(BAG_DETAILS_KEY, bagDetails);
  }, [bagDetails, loaded]);

  useEffect(() => {
    if (!loaded) return;
    saveToStorage(BAG_WEIGHTS_KEY, bagWeights);
  }, [bagWeights, loaded]);

  useEffect(() => {
    if (!loaded) return;
    if (!account) {
      AsyncStorage.removeItem(SYNC_KEY).catch(() => undefined);
      return;
    }
    const { token: _token, ...stored } = account;
    saveToStorage(SYNC_KEY, stored);
    lastAccount.current = { id: account.user.id, email: account.user.email, pushedThrough: account.pushedThrough };
    saveToStorage(LAST_ACCOUNT_KEY, lastAccount.current);
  }, [account, loaded]);

  useEffect(() => {
    if (!loaded) return;
    saveToStorage(SYNC_META_KEY, { bagUpdatedAt, deletedCourses, deletedRounds });
  }, [bagUpdatedAt, deletedCourses, deletedRounds, loaded]);

  // Sync runs from timers and app-state events, so it reads the latest values from here.
  const syncData: SyncData = { courses, history, bag, bagDetails, bagWeights, bagUpdatedAt, deletedCourses, deletedRounds };
  const latestSync = useRef({ data: syncData, account });
  useEffect(() => {
    latestSync.current = { data: syncData, account };
  });
  const pendingChanges = account ? countPendingChanges(syncData, account.pushedThrough) : 0;

  const signOutLocally = () => {
    SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined);
    setAccount(null);
  };

  const runSync = async () => {
    const { data, account: current } = latestSync.current;
    if (!current || syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncing(true);
    const startedAt = nowMs();
    try {
      // Each batch's changes are kept as it arrives; local edits count as uploaded only once every batch is in.
      await sendInBatches(buildSyncRequest(data, current), (batch) => syncWithServer(current.token, batch), (batch, result) => {
        setCourses((local) => mergeCourses(local, result.courses));
        setHistory((local) => mergeRounds(local, result.rounds));
        setDeletedCourses((local) => clearSentTombstones(local, batch.courses));
        setDeletedRounds((local) => clearSentTombstones(local, batch.rounds));
        if (result.bag && result.bag.updatedAt > latestSync.current.data.bagUpdatedAt) {
          setBag(result.bag.discs);
          setBagDetails(result.bag.details);
          setBagWeights(result.bag.weights ?? {});
          setBagUpdatedAt(result.bag.updatedAt);
        }
        setAccount((acct) => (acct?.token === current.token ? { ...acct, cursor: result.cursor } : acct));
      });
      setAccount((acct) => (acct?.token === current.token ? { ...acct, pushedThrough: startedAt, lastSyncedAt: nowMs() } : acct));
      setSyncError('');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        signOutLocally();
        setSyncError('Your session expired. Sign in again to keep syncing.');
      } else {
        setSyncError(errorMessage(error, 'Sync failed.'));
      }
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
    }
  };

  const runSyncRef = useRef(runSync);
  useEffect(() => {
    runSyncRef.current = runSync;
  });

  // Sync on launch and right after signing in.
  useEffect(() => {
    if (loaded && account?.token) runSyncRef.current();
  }, [loaded, account?.token]);

  // While the round screen is open: keep the screen on and dimmed, restoring brightness on the
  // way out. iOS restores brightness itself when the phone locks, so dim again on return.
  useEffect(() => {
    if (screen !== 'Round') return;
    let left = false;
    (async () => {
      try {
        await activateKeepAwakeAsync(ROUND_KEEP_AWAKE_TAG);
        const current = await Brightness.getBrightnessAsync();
        if (left) return;
        savedBrightness.current = current;
        await Brightness.setBrightnessAsync(ROUND_BRIGHTNESS);
      } catch {
        // Dimming and keep-awake are niceties; the round works without them.
      }
    })();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') Brightness.setBrightnessAsync(ROUND_BRIGHTNESS).catch(() => undefined);
    });
    return () => {
      left = true;
      subscription.remove();
      Promise.resolve(deactivateKeepAwake(ROUND_KEEP_AWAKE_TAG)).catch(() => undefined);
      if (savedBrightness.current !== null) Brightness.setBrightnessAsync(savedBrightness.current).catch(() => undefined);
      savedBrightness.current = null;
    };
  }, [screen]);

  // Sync whenever the app comes back to the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') runSyncRef.current();
    });
    return () => subscription.remove();
  }, []);

  // Sync shortly after local edits.
  useEffect(() => {
    if (!loaded || !account || !pendingChanges) return;
    const timer = setTimeout(() => runSyncRef.current(), SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [loaded, account, pendingChanges, courses, history, bag, bagDetails, bagWeights, deletedCourses, deletedRounds]);

  // User edits to courses go through here so each changed course gets a fresh edit time for sync.
  const updateCourses = (updater: (current: Course[]) => Course[]) => {
    const stamp = nowMs();
    setCourses((existing) => updater(existing).map((course) => (existing.includes(course) ? course : { ...course, updatedAt: stamp })));
  };

  const updateCourseLayout = (courseId: string, layoutId: string, change: (layout: CourseLayout) => CourseLayout) => {
    updateCourses((current) => current.map((course) => (course.id === courseId ? updateLayoutIn(course, layoutId, change) : course)));
  };

  // Exactly `holes` entries, so a hole can be written by index.
  const fullHoleLayouts = (layout: CourseLayout) => Array.from({ length: layout.holes }, (_, index) => layout.layouts[index] ?? { tee: null, basket: null });

  // Search DiscIt as the user types, fetching only the matching discs.
  useEffect(() => {
    const query = bagEntry.trim();
    if (query.length < DISC_SEARCH_MIN_CHARS) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${DISCIT_API_URL}?name=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`DiscIt returned ${response.status}`);
        const results = (await response.json()) as DiscInfo[];
        const seen = new Set<string>();
        const unique = results.filter((item) => {
          const key = `${item.name}|${item.brand}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        setDiscSearch({ query, results: unique.slice(0, DISC_SEARCH_MAX_RESULTS), failed: false });
      } catch {
        if (controller.signal.aborted) return;
        setDiscSearch({ query, results: [], failed: true });
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [bagEntry]);

  const pastSessions = [...history].sort((a, b) => Number(b.id) - Number(a.id));
  const viewedSession = history.find((session) => session.id === viewedSessionId);
  const viewedBaseCourse = courses.find((course) => course.id === viewedSession?.courseId);
  // The layout the round was played on; undefined if the course or that layout was deleted.
  const viewedCourse = viewedBaseCourse && viewedSession ? withExistingLayout(viewedBaseCourse, viewedSession.layoutId) : undefined;
  const viewedLayoutLabel = viewedBaseCourse && courseLayouts(viewedBaseCourse).length > 1 ? (viewedCourse?.layoutLabel ?? viewedSession?.layoutName ?? 'Deleted') : null;
  const viewedHoles = viewedSession
    ? [...new Set(viewedSession.shots.map((shot) => shot.hole))].sort((a, b) => a - b).map((holeNumber) => {
      const holeShots = viewedSession.shots.filter((shot) => shot.hole === holeNumber);
      return { hole: holeNumber, shots: holeShots, par: viewedCourse?.layouts?.[holeNumber - 1]?.par, feet: holeShots.reduce((sum, shot) => sum + shot.feet, 0) };
    })
    : [];
  const viewedScore = viewedSession ? scoreSummary(viewedSession.shots, viewedCourse) : null;
  const viewedPar = viewedHoles.reduce((sum, item) => sum + (item.par ?? 0), 0);
  const viewedResults = RESULT_TYPES.map((result) => ({
    ...result,
    count: viewedHoles.filter((item) => item.par !== undefined && result.matches(countStrokes(item.shots) - item.par)).length,
  })).filter((result) => result.count > 0);
  const sessionSummary = (session: SessionArchive) => {
    const baseCourse = courses.find((course) => course.id === session.courseId);
    const summary = scoreSummary(session.shots, baseCourse ? withExistingLayout(baseCourse, session.layoutId) : undefined);
    const holesText = `${summary.holesCompleted} ${summary.holesCompleted === 1 ? 'hole' : 'holes'}`;
    if (session.mode === 'Practice') return `${holesText} · ${summary.strokes} ${summary.strokes === 1 ? 'throw' : 'throws'}`;
    return `${holesText} · Score ${summary.strokes}${summary.toPar === null ? '' : ` (${formatScoreToPar(summary.toPar)})`}`;
  };

  const discQuery = bagEntry.trim();
  const discSearchPending = discSearch.query !== discQuery;
  const discResults = discSearchPending ? [] : discSearch.results;

  const activeShots = shots.filter((shot) => shot.hole === hole);
  const score = activeShots.length;
  const holeStrokes = countStrokes(activeShots);
  const holeFeet = activeShots.reduce((total, shot) => total + shot.feet, 0);
  const allShots = [...history.flatMap((session) => session.shots), ...shots];
  // Stats screen: finished sessions, optionally with practice, grouped by course.
  const sessionLayouts = (session: SessionArchive) => {
    const base = courses.find((course) => course.id === session.courseId);
    return (base ? withExistingLayout(base, session.layoutId)?.layouts : undefined) ?? [];
  };
  const statsSessions = history.filter((session) => statsPractice || session.mode === 'Round');
  const statsCourseKey = (session: SessionArchive) => session.courseId ?? `name:${session.courseName}`;
  const statsCourses = [...statsSessions.reduce((groups, session) => {
    const key = statsCourseKey(session);
    const group = groups.get(key) ?? { key, name: courses.find((course) => course.id === session.courseId)?.name ?? session.courseName, sessions: [] as SessionArchive[] };
    group.sessions.push(session);
    return groups.set(key, group);
  }, new Map<string, { key: string; name: string; sessions: SessionArchive[] }>()).values()].sort((a, b) => b.sessions.length - a.sessions.length || a.name.localeCompare(b.name));
  const activeStatsCourse = statsCourses.some((group) => group.key === statsCourse) ? statsCourse : 'all';
  const statsSelected = activeStatsCourse === 'all' ? statsSessions : statsCourses.find((group) => group.key === activeStatsCourse)!.sessions;
  const statsScores = statsSelected.filter((session) => session.mode === 'Round').map((session) => ({ session, score: statsRoundScore(session.shots, sessionLayouts(session)) }));
  const statsWithPar = statsScores.filter((item) => item.score.toPar !== null);
  const statsBest = statsWithPar.reduce<(typeof statsWithPar)[number] | null>((best, item) => (!best || item.score.toPar! < best.score.toPar! ? item : best), null);
  const averageOf = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const selectedBaseCourse = courses.find((course) => course.id === selectedCourseId) ?? courses[0];
  // Most screens work on the selected layout of the selected course.
  const selectedCourse: CourseView | undefined = selectedBaseCourse ? withLayout(selectedBaseCourse, selectedLayoutId) : undefined;
  const selectedCourseLayouts = selectedBaseCourse ? courseLayouts(selectedBaseCourse) : [];
  const hasMultipleLayouts = selectedCourseLayouts.length > 1;
  const selectedHoleLayout = selectedCourse?.layouts?.[hole - 1];
  const roundScore = scoreSummary(shots, selectedCourse, hole);
  const selectedCourseStats = selectedCourse ? courseStats(selectedCourse) : null;
  const editorHoleLayout = selectedCourse?.layouts?.[builderHole - 1];
  const mappedHoleCount = selectedCourse?.layouts?.filter((layout) => layout.tee && layout.basket).length ?? 0;
  const visibleMapWidthFeet = mapRegion
    ? (mapRegion.longitudeDelta * METERS_PER_DEGREE * Math.cos((mapRegion.latitude * Math.PI) / 180)) / 0.3048
    : MAP_VIEW_WIDTH_FEET;
  const scaleBarFeet = [...MAP_SCALE_BAR_OPTIONS_FEET].reverse().find((feet) => feet <= visibleMapWidthFeet * 0.4) ?? MAP_SCALE_BAR_OPTIONS_FEET[0];
  const scaleBarWidth = mapViewportWidth > 0
    ? Math.min(mapViewportWidth * 0.7, (scaleBarFeet / Math.max(1, visibleMapWidthFeet)) * mapViewportWidth)
    : 52;
  const editorHoleDistance = holeDistanceFeet(editorHoleLayout);
  const selectedHoleDistance = holeDistanceFeet(selectedHoleLayout);
  // From the last logged lie on this hole to the basket, once the hole is under way and not finished.
  const lastLie = shots.filter((shot) => shot.hole === hole).findLast((shot) => shot.latitude !== undefined && shot.longitude !== undefined);
  const holeBasket = selectedHoleLayout?.basket;
  const lieToBasket = lastLie && holeBasket && lastLie.lie !== 'Basket' ? {
    feet: Math.round(feetBetween({ latitude: lastLie.latitude!, longitude: lastLie.longitude! }, holeBasket)),
    elevation: typeof lastLie.altitude === 'number' && typeof holeBasket.altitude === 'number' ? Math.round((holeBasket.altitude - lastLie.altitude) / 0.3048) : null,
  } : null;
  // The caddie: discs whose average distance best matches what's left to the basket.
  const caddieFrom = lastLie ? { latitude: lastLie.latitude!, longitude: lastLie.longitude! } : selectedHoleLayout?.tee ?? null;
  const caddieTargetFeet = caddieFrom && holeBasket && !shots.some((shot) => shot.hole === hole && shot.lie === 'Basket') ? Math.round(feetBetween(caddieFrom, holeBasket)) : null;
  const caddieType = guessThrowType(shots.filter((shot) => shot.hole === hole), caddieFrom, holeBasket);
  const caddie = caddieTargetFeet === null ? [] : suggestDiscs(caddieTargetFeet, caddieType, allShots, bag);
  const mappedShots = activeShots.flatMap((shot, index) =>
    shot.latitude !== undefined && shot.longitude !== undefined ? [{ index, coordinate: { latitude: shot.latitude, longitude: shot.longitude } }] : []);
  const lastMappedShot = mappedShots.at(-1);
  const roundMapRegion = regionForHole(selectedHoleLayout) ?? (lastMappedShot ? regionAtPoint(lastMappedShot.coordinate) : null);
  const latestShot = activeShots.at(-1);
  const throwPath = [...(selectedHoleLayout?.tee ? [selectedHoleLayout.tee] : []), ...mappedShots.map((shot) => shot.coordinate)];

  const openHoleWizard = async (course: Course) => {
    setSelectedCourseId(course.id);
    setBuilderHole(1);
    setScreen('HoleWizard');
    setMapRegion(null);
    setMapLoading(true);
    setGpsMessage('Finding your location…');
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      setLocationAllowed(permission.status === 'granted');
      if (permission.status !== 'granted') {
        const savedPoint = course.layouts?.[0]?.tee ?? course.layouts?.[0]?.basket;
        if (savedPoint) setMapRegion(regionAtPoint(savedPoint));
        setGpsMessage(permission.canAskAgain ? 'Allow location access to center the satellite map and save hole points.' : 'Enable location access in Settings to map a new hole.');
        return;
      }
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setMapRegion(regionAtPoint(fix.coords));
      setGpsMessage('');
    } catch {
      const savedPoint = course.layouts?.[0]?.tee ?? course.layouts?.[0]?.basket;
      if (savedPoint) setMapRegion(regionAtPoint(savedPoint));
      setGpsMessage('Could not find your location. Try again outdoors.');
    } finally {
      setMapLoading(false);
    }
  };

  const moveWizardHole = async (nextHole: number, isNewHole = false) => {
    if (!selectedCourse || nextHole < 1 || (!isNewHole && nextHole > selectedCourse.holes)) return;
    setBuilderHole(nextHole);
    setGpsMessage('');
    const savedPoint = selectedCourse.layouts?.[nextHole - 1]?.tee ?? selectedCourse.layouts?.[nextHole - 1]?.basket;
    if (savedPoint) {
      setMapRegion(regionAtPoint(savedPoint));
      return;
    }
    if (!locationAllowed) return;
    try {
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setMapRegion(regionAtPoint(fix.coords));
    } catch {
      setGpsMessage('Use Recenter to locate this hole on the satellite map.');
    }
  };

  const recenterSatelliteMap = async () => {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationAllowed(false);
        setGpsMessage('Location access is needed to recenter the map.');
        return;
      }
      setLocationAllowed(true);
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setMapRegion(regionAtPoint(fix.coords));
      setGpsMessage('');
    } catch {
      setGpsMessage('Could not find your location. Try again outdoors.');
    }
  };

  const saveCoursePoint = async (target: 'tee' | 'basket') => {
    if (!selectedCourse || savingGpsTarget) return;
    const courseId = selectedCourse.id;
    const layoutId = selectedCourse.layoutId;
    const targetHole = builderHole;
    setSavingGpsTarget(target);
    setGpsMessage('Waiting for a GPS fix…');
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationAllowed(false);
        setGpsMessage(permission.canAskAgain ? 'Location permission is needed to save this point.' : 'Enable location access for Glide Path in Settings, then try again.');
        return;
      }
      setLocationAllowed(true);
      if (!(await Location.hasServicesEnabledAsync())) {
        setGpsMessage('Turn on Location Services, then save this point again.');
        return;
      }
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: true });
      const point: GpsPoint = {
        latitude: fix.coords.latitude,
        longitude: fix.coords.longitude,
        accuracy: fix.coords.accuracy,
        timestamp: fix.timestamp,
        altitude: fix.coords.altitude,
        altitudeAccuracy: fix.coords.altitudeAccuracy,
      };
      setMapRegion(regionAtPoint(point));
      updateCourseLayout(courseId, layoutId, (layout) => {
        const layouts = fullHoleLayouts(layout);
        layouts[targetHole - 1] = { ...(layouts[targetHole - 1] ?? { tee: null, basket: null }), [target]: point };
        return { ...layout, layouts };
      });
      const accuracyText = point.accuracy === null ? 'accuracy unavailable' : `accuracy ±${Math.round(point.accuracy)} m`;
      setGpsMessage(`${target === 'tee' ? 'Tee box' : 'Basket'} saved · ${accuracyText}${point.accuracy !== null && point.accuracy > 25 ? '. GPS is weak; wait a moment and save again for a better fix.' : '.'}`);
    } catch {
      setGpsMessage('Could not get a GPS fix. Move outdoors, wait briefly, and try again.');
    } finally {
      setSavingGpsTarget(null);
    }
  };

  const setHolePar = (par: number, targetHole = builderHole) => {
    if (!selectedCourse) return;
    updateCourseLayout(selectedCourse.id, selectedCourse.layoutId, (layout) => {
      const layouts = fullHoleLayouts(layout);
      layouts[targetHole - 1] = { ...layouts[targetHole - 1], par };
      return { ...layout, layouts };
    });
  };

  // Where the throw being logged was thrown from: the last positioned throw on this hole, or the tee.
  const previousLiePoint = () => {
    const previousShot = activeShots.findLast((shot) => shot.latitude !== undefined && shot.longitude !== undefined);
    return previousShot ? { latitude: previousShot.latitude!, longitude: previousShot.longitude! } : selectedHoleLayout?.tee ?? null;
  };

  // Reads the GPS position at the disc. Reports progress and problems through `report`.
  const captureLie = async (report: (message: string) => void) => {
    report('Getting a GPS fix at your lie…');
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationAllowed(false);
        report(permission.canAskAgain ? 'Location permission is needed to log where your disc landed.' : 'Enable location access for Glide Path in Settings, then try again.');
        return null;
      }
      setLocationAllowed(true);
      if (!(await Location.hasServicesEnabledAsync())) {
        report('Turn on Location Services, then log the throw again.');
        return null;
      }
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: true });
      const lie = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
      const previous = previousLiePoint();
      return { ...lie, altitude: fix.coords.altitude, feet: previous ? Math.max(1, Math.round(feetBetween(previous, lie))) : 0 };
    } catch {
      report('Could not get a GPS fix. Wait a moment and try again.');
      return null;
    }
  };

  // Best guesses for a throw, so most throws need no changes: a drive from the tee, a putt from
  // within C2 of the basket, otherwise an approach; the disc last used for that kind of throw.
  const guessThrow = (): { type: ThrowType; disc: Disc } => {
    const from = previousLiePoint();
    const basket = selectedHoleLayout?.basket;
    const type = guessThrowType(activeShots, from, basket);
    // Newest first: this round's throws, then past rounds from newest to oldest.
    const pastShots = [...history].sort((a, b) => Number(a.id) - Number(b.id)).flatMap((session) => session.shots);
    const recent = [...pastShots, ...shots].reverse();
    // The caddie's pick from where this throw was thrown, then the last disc used for the type.
    const suggested = from && basket ? suggestDiscs(Math.round(feetBetween(from, basket)), type, recent, bag, 1)[0]?.disc : undefined;
    return { type, disc: suggested ?? guessDisc(type, recent, bag, bagDetails, disc) };
  };

  // Adds a throw to the round in progress. Returns a short description for confirmations.
  const recordThrow = (point: { latitude: number; longitude: number; altitude: number | null; feet: number }, details: { type: ThrowType; disc: Disc; style: ThrowStyle; lie: Lie; quality: number | null }) => {
    let { latitude, longitude, altitude, feet } = point;
    // A throw that went in is recorded at the basket, measured from the previous lie (or the tee),
    // rather than wherever the player was standing when they logged it.
    const basket = selectedHoleLayout?.basket;
    if (details.lie === 'Basket' && basket) {
      const previous = previousLiePoint();
      latitude = basket.latitude;
      longitude = basket.longitude;
      altitude = basket.altitude ?? null;
      feet = previous ? Math.max(1, Math.round(feetBetween(previous, basket))) : 0;
    }
    const shot: Shot = {
      x: 0.5, y: 0.5, feet, disc: details.disc, type: details.type, hole, courseId: selectedCourse?.id, latitude, longitude, altitude,
      style: details.style, lie: details.lie, ...(details.quality === null ? {} : { quality: details.quality, qualityMax: QUALITY_MAX }),
    };
    setShots((current) => [...current, shot]);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    setThrowType(details.type === 'Putt' ? 'Putt' : 'Approach');
    const summary = `Throw ${score + 1} · ${formatThrowDetail(shot)}`;
    if (details.lie !== 'Basket') return summary;
    // A made basket finishes the hole.
    const throwCount = holeStrokes + 1;
    const holeCount = selectedCourse?.holes ?? 18;
    setThrowLie('Fairway');
    if (hole >= holeCount) {
      setRoundMessage(`Hole ${hole} complete in ${throwCount} ${throwCount === 1 ? 'stroke' : 'strokes'}. That was the last hole.`);
      promptLastHoleComplete();
      return `Hole ${hole} complete in ${throwCount}. That was the last hole.`;
    }
    setHole(hole + 1);
    setThrowType('Drive');
    setRoundMessage(`Hole ${hole} complete in ${throwCount} ${throwCount === 1 ? 'stroke' : 'strokes'}. On to hole ${hole + 1}.`);
    return `Hole ${hole} complete in ${throwCount}. On to hole ${hole + 1}.`;
  };

  // Captures the player's GPS position at the disc, then asks for disc, throw type and quality,
  // starting from the best guesses.
  const startLogThrow = async () => {
    if (loggingThrow) return;
    setLoggingThrow(true);
    const point = await captureLie(setRoundMessage);
    setLoggingThrow(false);
    if (!point) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      return;
    }
    const guess = guessThrow();
    setThrowType(guess.type);
    setDisc(guess.disc);
    setThrowLie(guess.type === 'Putt' ? 'Missed' : 'Fairway');
    setPendingLie(point);
    setLogStep(1);
    setRoundMessage('');
  };

  const cancelLogThrow = () => setPendingLie(null);

  // `quality` is null when the throw is saved without a rating.
  const saveThrow = (quality: number | null, lie: Lie = throwLie) => {
    if (!pendingLie) return;
    recordThrow(pendingLie, { type: throwType, disc, style: throwStyle, lie, quality });
    setPendingLie(null);
  };


  const startNextHole = () => {
    setHole((current) => (current >= (selectedCourse?.holes ?? 18) ? 1 : current + 1));
    setThrowType('Drive');
    setScreen('Round');
  };

  const goToPreviousHole = () => {
    if (hole <= 1) return;
    const previousHole = hole - 1;
    setHole(previousHole);
    setThrowType(nextThrowType(shots.filter((shot) => shot.hole === previousHole)));
  };

  // Moves the current session's throws into history so a new one can begin.
  const archiveSession = () => {
    const id = shots.length ? (resumedFrom?.id ?? newSessionId()) : null;
    if (id) {
      const record: SessionArchive = {
        id, mode, courseName: selectedCourse?.name ?? 'Practice area', courseId: selectedCourse?.id,
        layoutId: selectedCourse?.layoutId, layoutName: selectedCourse?.layoutLabel,
        shots, updatedAt: nowMs(), shared: resumedFrom?.shared, shareToken: resumedFrom?.shareToken,
      };
      setHistory((current) => [...current.filter((session) => session.id !== id), record]);
    }
    setShots([]);
    setSessionActive(false);
    setResumedFrom(null);
    return id;
  };

  const deleteRound = (session: SessionArchive) => {
    const kind = session.mode === 'Round' ? 'round' : 'practice session';
    Alert.alert(
      `Delete this ${kind}?`,
      `${session.courseName}, ${formatSessionDate(session)}. Its score and every throw will be permanently deleted${account ? ' from this phone, your other devices and the website' : ''}.${session.shared ? ' Its share link will stop working.' : ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Delete ${kind}`,
          style: 'destructive',
          onPress: () => {
            setHistory((current) => current.filter((item) => item.id !== session.id));
            setDeletedRounds((current) => [...current, { clientId: session.id, updatedAt: nowMs() }]);
            if (viewedSessionId === session.id) {
              setViewedSessionId(null);
              setScreen('Rounds');
            }
          },
        },
      ],
    );
  };

  const undoLastThrow = () => {
    const last = activeShots.at(-1);
    if (!last) return;
    Alert.alert('Undo the last throw?', `Throw ${activeShots.length} on hole ${hole} (${formatThrowDetail(last)}) will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Undo throw',
        style: 'destructive',
        onPress: () => setShots((current) => {
          const lastActiveIndex = current.findLastIndex((shot) => shot.hole === hole);
          return current.filter((_, index) => index !== lastActiveIndex);
        }),
      },
    ]);
  };

  // Reopens a past round as the round in progress, at its last unfinished hole.
  const resumeSession = (session: SessionArchive) => {
    const course = courses.find((item) => item.id === session.courseId);
    const start = () => {
      archiveSession();
      setHistory((current) => current.filter((item) => item.id !== session.id));
      setShots(session.shots);
      setMode(session.mode);
      if (course) setSelectedCourseId(course.id);
      setSelectedLayoutId(session.layoutId ?? MAIN_LAYOUT_ID);
      const holeCount = course ? withLayout(course, session.layoutId).holes : Infinity;
      const lastHole = Math.max(1, ...session.shots.map((shot) => shot.hole));
      const lastHoleDone = session.shots.some((shot) => shot.hole === lastHole && shot.lie === 'Basket');
      const nextHole = lastHoleDone && lastHole < holeCount ? lastHole + 1 : lastHole;
      setHole(nextHole);
      setThrowType(nextThrowType(session.shots.filter((shot) => shot.hole === nextHole)));
      setThrowLie('Fairway');
      setResumedFrom({ id: session.id, shared: session.shared, shareToken: session.shareToken });
      setSessionActive(true);
      setShowingRoundSummary(false);
      setRoundMessage(`Resumed on hole ${nextHole}.`);
      setScreen('Round');
    };
    if (sessionActive && shots.length) {
      Alert.alert(
        `Resume this ${session.mode === 'Round' ? 'round' : 'session'}?`,
        `Your ${mode === 'Round' ? 'round' : 'practice session'} in progress will be ended and saved to your history first.`,
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Resume', onPress: start }],
      );
      return;
    }
    start();
  };

  // Ends the session; a finished round opens its summary, anything else returns home.
  const finishSession = () => {
    const id = archiveSession();
    if (id && mode === 'Round') {
      setViewedSessionId(id);
      setExpandedHole(null);
      setShowingRoundSummary(true);
      setScreen('RoundDetail');
      return;
    }
    setScreen('Home');
  };

  const promptLastHoleComplete = () => {
    Alert.alert(
      mode === 'Round' ? 'Round complete' : 'Last hole complete',
      `Hole ${hole} was the last hole on ${selectedCourse?.name ?? 'this course'}. End the ${mode === 'Round' ? 'round' : 'practice session'} and save it to your history?`,
      [
        { text: 'Keep playing', style: 'cancel' },
        { text: mode === 'Round' ? 'End round & see summary' : 'End practice', onPress: finishSession },
      ],
    );
  };

  const finishHole = () => {
    const completeHole = () => {
      if (mode === 'Round' && hole >= (selectedCourse?.holes ?? 18)) {
        promptLastHoleComplete();
        return;
      }
      startNextHole();
    };
    // In a round, a hole normally ends with a throw in the basket; check before moving on without one.
    if (mode === 'Round' && !activeShots.some((shot) => shot.lie === 'Basket')) {
      Alert.alert(
        `Finish hole ${hole}?`,
        activeShots.length
          ? `None of the ${activeShots.length} ${activeShots.length === 1 ? 'throw' : 'throws'} on this hole was logged in the basket. Your score for the hole will be ${holeStrokes}.`
          : 'No throws have been logged on this hole.',
        [
          { text: 'Keep playing', style: 'cancel' },
          { text: 'Finish hole', onPress: completeHole },
        ],
      );
      return;
    }
    completeHole();
  };

  const beginSession = (nextMode: 'Round' | 'Practice', layoutId?: string, courseId?: string) => {
    archiveSession();
    if (courseId) setSelectedCourseId(courseId);
    if (layoutId) setSelectedLayoutId(layoutId);
    setMode(nextMode);
    setHole(1);
    setThrowType('Drive');
    setThrowLie('Fairway');
    setRoundMessage('');
    setSessionActive(true);
    setScreen('Round');
  };

  // Starting over while a session is in progress needs confirmation; the old session goes to history.
  const confirmNewSession = (nextMode: 'Round' | 'Practice', layoutId?: string, courseId?: string) => {
    if (!sessionActive) {
      beginSession(nextMode, layoutId, courseId);
      return;
    }
    Alert.alert(
      `Start a new ${nextMode === 'Round' ? 'round' : 'practice session'}?`,
      `Your ${mode === 'Round' ? 'round' : 'practice session'} in progress (${shots.length} ${shots.length === 1 ? 'throw' : 'throws'}) will be ended and saved to your session history.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start new', style: 'destructive', onPress: () => beginSession(nextMode, layoutId, courseId) },
      ],
    );
  };

  // Starting a round asks for the course, then the layout when the course has more than one.
  const startRound = () => {
    if (!courses.length) {
      Alert.alert('Create a course first', 'Add a course in Course Builder before starting a round.');
      return;
    }
    setRoundPickerCourseId(null);
    setRoundPickerOpen(true);
  };

  const pickRoundCourse = (course: Course) => {
    if (courseLayouts(course).length > 1) {
      setRoundPickerCourseId(course.id);
      return;
    }
    pickRoundLayout(course, MAIN_LAYOUT_ID);
  };

  const pickRoundLayout = (course: Course, layoutId: string) => {
    setRoundPickerOpen(false);
    setRoundPickerCourseId(null);
    if (course.id !== selectedCourseId) setBuilderHole(1);
    confirmNewSession('Round', layoutId, course.id);
  };

  const selectLayout = (layoutId: string) => {
    const apply = () => {
      setSelectedLayoutId(layoutId);
      setBuilderHole(1);
    };
    if (sessionActive && shots.length && selectedCourse && selectedCourse.layoutId !== layoutId) {
      Alert.alert('Round in progress', 'Your round in progress uses the selected layout, so switching layouts switches it for that round too.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Switch layout', onPress: apply },
      ]);
      return;
    }
    apply();
  };

  const addLayout = (copySelected: boolean) => {
    if (!selectedCourse) return;
    const id = `layout-${newSessionId()}`;
    const name = newLayoutName.trim() || `Layout ${selectedCourseLayouts.length + 1}`;
    const layout: CourseLayout = copySelected
      ? { id, name, holes: selectedCourse.holes, layouts: Array.from({ length: selectedCourse.holes }, (_, index) => ({ ...(selectedCourse.layouts?.[index] ?? { tee: null, basket: null }) })) }
      : { id, name, holes: 1, layouts: [{ tee: null, basket: null }] };
    const courseId = selectedCourse.id;
    updateCourses((current) => current.map((course) => (course.id === courseId ? { ...course, extraLayouts: [...(course.extraLayouts ?? []), layout] } : course)));
    selectLayout(id);
    setNewLayoutName('');
  };

  const deleteLayout = (course: Course, layout: CourseLayout) => {
    Alert.alert(
      `Delete the ${layoutDisplayName(layout)} layout?`,
      'Its holes, tees, baskets and pars will be removed. Past rounds played on it keep their scores but no longer show par or maps.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete layout',
          style: 'destructive',
          onPress: () => {
            updateCourses((current) => current.map((item) => (item.id === course.id ? { ...item, extraLayouts: (item.extraLayouts ?? []).filter((extra) => extra.id !== layout.id) } : item)));
            if (selectedLayoutId === layout.id) setSelectedLayoutId(MAIN_LAYOUT_ID);
          },
        },
      ],
    );
  };

  // Editing throws, in past rounds or the round in progress.
  const editingActive = editingThrow?.sessionId === ACTIVE_SESSION_ID;
  const editingSession = editingThrow && !editingActive ? history.find((session) => session.id === editingThrow.sessionId) : undefined;
  const editingShots = editingActive ? shots : editingSession?.shots;
  const editingShot = editingThrow ? editingShots?.[editingThrow.index] : undefined;
  // The hole layouts the edited throws were played on, for moving made throws to the basket.
  const editingLayouts = editingActive ? selectedCourse?.layouts : viewedCourse && viewedCourse.id === editingSession?.courseId ? viewedCourse.layouts : undefined;
  const editDiscOptions = [...new Set([...(editingShot?.disc ? [editingShot.disc] : []), ...bag])];

  const openThrowEditor = (session: Pick<SessionArchive, 'id' | 'shots'>, shot: Shot) => {
    const index = session.shots.indexOf(shot);
    if (index < 0) return;
    // Throws rated on the old 1-5 scale are converted to the current scale.
    const quality = shot.quality ? Math.min(QUALITY_MAX, Math.max(1, Math.round((shot.quality / (shot.qualityMax ?? 5)) * QUALITY_MAX))) : null;
    setThrowDraft({ disc: shot.disc, type: shot.type, style: shot.style, lie: shot.lie ?? 'Fairway', quality });
    setEditingThrow({ sessionId: session.id, index });
  };

  const openActiveThrowEditor = (shot: Shot) => openThrowEditor({ id: ACTIVE_SESSION_ID, shots }, shot);

  const updateSessionShots = (sessionId: string, change: (list: Shot[]) => Shot[]) => {
    if (sessionId === ACTIVE_SESSION_ID) {
      setShots(change);
      return;
    }
    const stamp = nowMs();
    setHistory((current) => current.map((session) => (session.id === sessionId ? { ...session, shots: change(session.shots), updatedAt: stamp } : session)));
  };

  const saveThrowEdit = () => {
    if (!editingThrow) return;
    const { sessionId, index } = editingThrow;
    // A throw changed to "in the basket" moves to the basket, as when it's logged that way;
    // distances on the hole are then remeasured from each previous lie.
    const layout = editingShot ? editingLayouts?.[editingShot.hole - 1] : undefined;
    const moveToBasket = throwDraft.lie === 'Basket' && editingShot?.lie !== 'Basket' && layout?.basket;
    updateSessionShots(sessionId, (list) => {
      const edited = list.map((shot, position) => (position === index
        ? {
          ...shot, disc: throwDraft.disc, type: throwDraft.type, style: throwDraft.style, lie: throwDraft.lie,
          ...(throwDraft.quality === null ? {} : { quality: throwDraft.quality, qualityMax: QUALITY_MAX }),
          ...(moveToBasket ? { latitude: layout.basket!.latitude, longitude: layout.basket!.longitude } : {}),
        }
        : shot));
      return moveToBasket && editingShot ? remeasureHole(edited, editingShot.hole, layout?.tee) : edited;
    });
    setEditingThrow(null);
  };

  const deleteEditingThrow = () => {
    if (!editingThrow || !editingShots || !editingShot) return;
    if (!editingActive && editingShots.length === 1) {
      Alert.alert('Keep one throw', 'A round needs at least one throw.');
      return;
    }
    const { sessionId, index } = editingThrow;
    const holeNumber = editingShot.hole;
    const tee = editingLayouts?.[holeNumber - 1]?.tee;
    Alert.alert('Delete this throw?', 'It will be removed from the round, and the score and the next throw’s distance updated.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete throw',
        style: 'destructive',
        onPress: () => {
          updateSessionShots(sessionId, (list) => remeasureHole(list.filter((_, position) => position !== index), holeNumber, tee));
          setEditingThrow(null);
        },
      },
    ]);
  };

  const startPractice = () => confirmNewSession('Practice');

  const endSession = () => {
    Alert.alert(
      `End this ${mode === 'Round' ? 'round' : 'practice session'}?`,
      'Your throws will be saved to your session history.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'End', onPress: finishSession },
      ],
    );
  };

  const startNewCourse = () => {
    setCourseName('');
    setNewCourseId(null);
    setNewCourseStep(1);
    setScreen('NewCourse');
  };

  // Step 1 of the new-course flow. New courses start with one hole on a Main layout; holes are
  // added while mapping. Coming back to step 1 renames the course instead of making another.
  const saveNewCourseName = () => {
    const name = courseName.trim();
    if (!name) return;
    if (newCourseId && courses.some((course) => course.id === newCourseId)) {
      updateCourses((current) => current.map((course) => (course.id === newCourseId ? { ...course, name } : course)));
    } else {
      const course: Course = { id: newSessionId(), name, holes: 1, layouts: [{ tee: null, basket: null }] };
      updateCourses((current) => [...current, course]);
      setNewCourseId(course.id);
      setSelectedCourseId(course.id);
      setSelectedLayoutId(MAIN_LAYOUT_ID);
      setBuilderHole(1);
    }
    setNewCourseStep(2);
  };

  // Opens hole mapping for one layout of a course, returning to `from` when finished.
  const mapLayout = (course: Course, layoutId: string, from: 'CourseBuilder' | 'NewCourse') => {
    setSelectedLayoutId(layoutId);
    setWizardReturn(from);
    openHoleWizard(withLayout(course, layoutId));
  };

  const updateCourseDetails = (courseId: string, details: CourseDetails) => {
    updateCourses((current) => current.map((course) => (course.id === courseId ? { ...course, ...details } : course)));
  };

  const setCoursePublished = (courseId: string, published: boolean) => {
    updateCourses((current) => current.map((course) => (course.id === courseId ? { ...course, published } : course)));
  };

  const setRoundShared = (sessionId: string, shared: boolean) => {
    const stamp = nowMs();
    setHistory((current) => current.map((session) => (session.id === sessionId ? { ...session, shared, shareToken: shared ? session.shareToken : null, updatedAt: stamp } : session)));
  };

  const shareLink = (message: string, url: string) => {
    // The link goes in the message only; passing it as `url` too makes iOS share it twice.
    Share.share({ message: `${message} ${url}` }).catch(() => undefined);
  };

  const switchAuthMode = (next: typeof authMode) => {
    setAuthMode(next);
    setAuthError('');
    setAuthNotice('');
  };

  const sendResetCode = async () => {
    const email = authEmail.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setAuthError('Enter the email address for your account.');
      return;
    }
    setAuthBusy(true);
    setAuthError('');
    try {
      await requestPasswordReset(email);
      setResetCode('');
      setAuthPassword('');
      setAuthMode('reset');
      setAuthNotice(`If ${email} has an account, a 6-digit code is on its way. It expires in 15 minutes; check your spam folder if it doesn’t arrive.`);
    } catch (error) {
      setAuthError(errorMessage(error, 'Could not send a reset code.'));
    } finally {
      setAuthBusy(false);
    }
  };

  // Empties this phone's courses, rounds, bag and round in progress, before downloading another account's.
  const clearLocalData = () => {
    setCourses([]);
    setHistory([]);
    setBag([]);
    setBagDetails({});
    setBagWeights({});
    setBagUpdatedAt(0);
    setDeletedCourses([]);
    setDeletedRounds([]);
    setShots([]);
    setHole(1);
    setDisc('');
    setSessionActive(false);
    setResumedFrom(null);
    setSelectedLayoutId(MAIN_LAYOUT_ID);
    setViewedSessionId(null);
  };

  // Signing in uploads this phone's data to the account, which can't be undone. If the data was
  // last synced with a different account, ask first. Returns false if the user cancels.
  const finishSignIn = async (result: { token: string; user: SyncAccount['user'] }) => {
    const previous = lastAccount.current;
    const hasLocalData = courses.length > 0 || history.length > 0 || bag.length > 0 || shots.length > 0;
    if (previous && previous.id !== result.user.id && hasLocalData) {
      const unsynced = countPendingChanges(syncData, previous.pushedThrough);
      const losses = [
        unsynced ? `${unsynced} ${unsynced === 1 ? 'change' : 'changes'} not yet synced to ${previous.email}` : '',
        sessionActive ? `the ${mode === 'Round' ? 'round' : 'practice session'} in progress` : '',
      ].filter(Boolean).join(' and ');
      const choice = await new Promise<'add' | 'replace' | 'cancel'>((resolve) => {
        Alert.alert(
          'Data from another account',
          `The courses, rounds and bag on this phone were last synced with ${previous.email}.\n\nAdd them to ${result.user.email}, or replace them with that account's data? Replacing leaves ${previous.email}'s synced data in its own account${losses ? `, but ${losses} will be lost` : ''}.`,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve('cancel') },
            { text: `Add to ${result.user.email}`, onPress: () => resolve('add') },
            { text: 'Replace', style: 'destructive', onPress: () => resolve('replace') },
          ],
          { cancelable: true, onDismiss: () => resolve('cancel') },
        );
      });
      if (choice === 'cancel') return false;
      if (choice === 'replace') clearLocalData();
    }
    await SecureStore.setItemAsync(TOKEN_KEY, result.token);
    setAccount({ token: result.token, user: result.user, cursor: 0, pushedThrough: 0 });
    return true;
  };

  const submitPasswordReset = async () => {
    const email = authEmail.trim();
    const code = resetCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setAuthError('Enter the 6-digit code from the email.');
      return;
    }
    if (authPassword.length < 8) {
      setAuthError('Use a new password of at least 8 characters.');
      return;
    }
    setAuthBusy(true);
    setAuthError('');
    try {
      const result = await resetPassword(email, code, authPassword);
      if (!(await finishSignIn(result))) return;
      setAuthPassword('');
      setResetCode('');
      setAuthNotice('');
      setAuthMode('signIn');
      setSyncError('');
    } catch (error) {
      setAuthError(errorMessage(error, 'Could not reset the password.'));
    } finally {
      setAuthBusy(false);
    }
  };

  const submitAuth = async () => {
    if (authMode === 'forgot') return sendResetCode();
    if (authMode === 'reset') return submitPasswordReset();
    const email = authEmail.trim();
    const name = authName.trim();
    if (!email || !authPassword || (authMode === 'register' && !name)) {
      setAuthError('Fill in every field.');
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setAuthError('Enter a valid email address.');
      return;
    }
    if (authMode === 'register' && authPassword.length < 8) {
      setAuthError('Use a password of at least 8 characters.');
      return;
    }
    setAuthBusy(true);
    setAuthError('');
    try {
      const result = authMode === 'register' ? await registerRequest(email, authPassword, name) : await signInRequest(email, authPassword);
      if (!(await finishSignIn(result))) return;
      setAuthPassword('');
      setSyncError('');
    } catch (error) {
      setAuthError(errorMessage(error, 'Could not sign in.'));
    } finally {
      setAuthBusy(false);
    }
  };

  const confirmSignOut = () => {
    Alert.alert(
      'Sign out?',
      `Your courses, rounds and bag stay on this phone.${pendingChanges ? ` ${pendingChanges} unsynced ${pendingChanges === 1 ? 'change' : 'changes'} will upload when you sign in again.` : ''}`,
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', onPress: signOutLocally }],
    );
  };

  const confirmDeleteAccount = () => {
    if (!account) return;
    const token = account.token;
    Alert.alert(
      'Delete your account?',
      'This permanently deletes your Glide Path account and everything synced to it, including published courses and shared round links. Data on this phone is kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete account',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteAccountRequest(token);
              setCourses((current) => current.map((course) => ({ ...course, uid: undefined, published: false })));
              setHistory((current) => current.map((session) => ({ ...session, shared: false, shareToken: null })));
              signOutLocally();
            } catch (error) {
              Alert.alert('Could not delete account', errorMessage(error, 'Try again when you have a connection.'));
            }
          },
        },
      ],
    );
  };

  const runCourseSearch = async (nearMe: boolean) => {
    setFindBusy(true);
    setFindError('');
    setPublicCourse(null);
    try {
      let near: { latitude: number; longitude: number } | undefined;
      if (nearMe) {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== 'granted') {
          setFindError('Location access is needed to find courses near you.');
          return;
        }
        setLocationAllowed(true);
        const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        near = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
      }
      const result = await searchCourses(nearMe ? '' : findQuery, near);
      setFindResults(result.courses);
      setFindNearby(nearMe);
    } catch (error) {
      setFindError(errorMessage(error, 'Search failed.'));
    } finally {
      setFindBusy(false);
    }
  };

  const openPublicCourse = async (uid: string) => {
    setPublicCourseLoading(uid);
    setFindError('');
    try {
      setPublicCourse((await getPublicCourse(uid)).course);
    } catch (error) {
      setFindError(errorMessage(error, 'Could not load that course.'));
    } finally {
      setPublicCourseLoading(null);
    }
  };

  // Copies a published course into this phone's courses as a new, private course.
  const addPublicCourse = (source: PublicCourse) => {
    const layouts: HoleLayout[] = Array.from({ length: source.holes }, (_, index) => {
      const layout = source.layouts[index];
      return { tee: layout?.tee ?? null, basket: layout?.basket ?? null, par: layout?.par };
    });
    const { address, street, city, state, phone, email, website, notes } = source.details;
    const extraLayouts = (source.extraLayouts ?? []).map(({ id, name, holes, layouts: holeLayouts }) => ({ id, name, holes, layouts: holeLayouts }));
    const course: Course = {
      id: newSessionId(), name: source.name, holes: source.holes, layouts, layoutName: source.layoutName, extraLayouts,
      address, street, city, state, phone, email, website, notes, sourceUid: source.uid,
    };
    updateCourses((current) => [...current, course]);
    setSelectedCourseId(course.id);
    setSelectedLayoutId(MAIN_LAYOUT_ID);
    Alert.alert('Course added', `${source.name} is now in your courses and selected for your next round.`);
  };

  const openCourseLink = (url: string) => {
    Linking.openURL(url).catch(() => Alert.alert('Could not open link', url));
  };

  // Tapping a hole in a past round opens its map, or closes it if it's already open.
  const toggleRoundHoleMap = (holeNumber: number, scrollToSection = false) => {
    const opening = expandedHole !== holeNumber;
    setExpandedHole(opening ? holeNumber : null);
    const offset = holeSectionOffsets.current[holeNumber];
    if (opening && scrollToSection && offset !== undefined) roundDetailScrollRef.current?.scrollTo({ y: Math.max(0, offset - 8), animated: true });
  };

  const renderRoundHoleMap = (holeNumber: number, holeShots: Shot[]) => {
    const layout = viewedCourse?.layouts?.[holeNumber - 1];
    const throws = holeShots.flatMap((shot, index) => shot.latitude !== undefined && shot.longitude !== undefined ? [{ index, shot, coordinate: { latitude: shot.latitude, longitude: shot.longitude } }] : []);
    const region = regionForPoints([...(layout?.tee ? [layout.tee] : []), ...(layout?.basket ? [layout.basket] : []), ...throws.map((item) => item.coordinate)]);
    if (!region) return <Text style={styles.mapInstruction}>No map positions were saved for this hole.</Text>;
    const path = [...(layout?.tee ? [layout.tee] : []), ...throws.map((item) => item.coordinate)];
    return <View style={styles.roundHoleMap}>
      <MapView style={styles.satelliteMap} mapType="satellite" initialRegion={region} showsMyLocationButton={false}>
        {layout?.tee && layout.basket && <Polyline coordinates={[layout.tee, layout.basket]} strokeColor="#ffffff" strokeWidth={2} lineDashPattern={[6, 4]} />}
        {path.length > 1 && <Polyline coordinates={path} strokeColor="#df8547" strokeWidth={3} />}
        {layout?.tee && <Marker coordinate={layout.tee} title={`Hole ${holeNumber} tee box`} pinColor="#1d684c" />}
        {layout?.basket && <BasketCircles basket={layout.basket} />}
        {layout?.basket && <Marker coordinate={layout.basket} title={`Hole ${holeNumber} basket`} pinColor="#d77d42" />}
        {throws.map((item) => <Marker key={`${item.index}-${item.coordinate.latitude}`} coordinate={item.coordinate} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} title={`Throw ${item.index + 1}`} description={formatThrowDetail(item.shot)}><View style={[styles.shotMarker, item.shot.lie === 'OB' && styles.obMarker]}><Text style={styles.shotPinText}>{item.index + 1}</Text></View></Marker>)}
      </MapView>
      {!viewedCourse && <View pointerEvents="none" style={styles.boardCaption}><Text style={styles.boardCaptionText}>COURSE OR LAYOUT DELETED · NO TEE OR BASKET</Text></View>}
    </View>;
  };

  const renderCourseLinks = (course: Course) => {
    const addressLine = courseAddressLine(course);
    const phone = course.phone?.trim();
    const email = course.email?.trim();
    const website = course.website?.trim();
    if (!addressLine && !phone && !email && !website) return null;
    return <View style={styles.courseLinks}>
      {addressLine ? <Pressable onPress={() => openCourseLink(`https://maps.apple.com/?q=${encodeURIComponent(addressLine)}`)} style={styles.courseLink}><Text style={styles.courseLinkText}>DIRECTIONS</Text></Pressable> : null}
      {phone ? <Pressable onPress={() => openCourseLink(`tel:${phone.replace(/[^\d+]/g, '')}`)} style={styles.courseLink}><Text style={styles.courseLinkText}>CALL</Text></Pressable> : null}
      {email ? <Pressable onPress={() => openCourseLink(`mailto:${email}`)} style={styles.courseLink}><Text style={styles.courseLinkText}>EMAIL</Text></Pressable> : null}
      {website ? <Pressable onPress={() => openCourseLink(/^https?:\/\//i.test(website) ? website : `https://${website}`)} style={styles.courseLink}><Text style={styles.courseLinkText}>WEBSITE</Text></Pressable> : null}
    </View>;
  };

  const addHoleToCourse = (courseId: string) => {
    updateCourseLayout(courseId, selectedLayoutId, (layout) => ({ ...layout, holes: layout.holes + 1, layouts: [...fullHoleLayouts(layout), { tee: null, basket: null }] }));
  };

  const addWizardHole = () => {
    if (!selectedCourse) return;
    const newHole = selectedCourse.holes + 1;
    addHoleToCourse(selectedCourse.id);
    moveWizardHole(newHole, true);
  };

  const deleteHole = (course: Course, holeNumber: number) => {
    if (course.holes <= 1) {
      Alert.alert('Keep one hole', 'A layout needs at least one hole. Delete the layout or course if you no longer need it.');
      return;
    }
    Alert.alert(
      `Delete hole ${holeNumber}?`,
      'Its tee and basket coordinates will be removed. Current throws on this hole will be deleted and later hole numbers will shift down.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete hole',
          style: 'destructive',
          onPress: () => {
            const belongsToCourse = (shot: Shot) => shot.courseId === course.id || (!shot.courseId && selectedCourseId === course.id);
            setShots((current) => current.flatMap((shot) => {
              if (!belongsToCourse(shot)) return [shot];
              if (shot.hole === holeNumber) return [];
              return [{ ...shot, hole: shot.hole > holeNumber ? shot.hole - 1 : shot.hole }];
            }));
            updateCourseLayout(course.id, selectedLayoutId, (layout) => ({ ...layout, holes: layout.holes - 1, layouts: fullHoleLayouts(layout).filter((_, index) => index !== holeNumber - 1) }));
            if (selectedCourseId === course.id) {
              setHole((current) => current === holeNumber ? Math.max(1, holeNumber - 1) : current > holeNumber ? current - 1 : current);
            }
            setBuilderHole(Math.max(1, holeNumber - 1));
          },
        },
      ],
    );
  };

  const deleteCourse = (course: Course) => {
    Alert.alert(
      `Delete ${course.name}?`,
      'This removes the course and all of its hole GPS coordinates. Logged throws will be kept in session history.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete course',
          style: 'destructive',
          onPress: () => {
            const belongsToCourse = (shot: Shot) => shot.courseId === course.id || (!shot.courseId && selectedCourseId === course.id);
            const courseShots = shots.filter(belongsToCourse);
            if (courseShots.length) {
              setHistory((current) => [...current, { id: newSessionId(), mode, courseName: course.name, courseId: course.id, shots: courseShots, updatedAt: nowMs() }]);
              setShots((current) => current.filter((shot) => !belongsToCourse(shot)));
            }
            const remainingCourses = courses.filter((item) => item.id !== course.id);
            setCourses(remainingCourses);
            setDeletedCourses((current) => [...current, { clientId: course.id, updatedAt: nowMs() }]);
            if (selectedCourseId === course.id) {
              setSelectedCourseId(remainingCourses[0]?.id ?? '');
              setHole(1);
            }
            setBuilderHole(1);
          },
        },
      ],
    );
  };

  const addDisc = () => {
    const name = bagEntry.trim();
    if (!name || bag.includes(name)) return;
    setBag((current) => [...current, name]);
    setBagUpdatedAt(nowMs());
    setDisc(name);
    setBagEntry('');
  };

  const deleteDisc = (name: Disc) => {
    Alert.alert(
      `Remove ${name}?`,
      'It will be removed from your bag. Throws already logged with this disc are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove disc',
          style: 'destructive',
          onPress: () => {
            const remaining = bag.filter((item) => item !== name);
            setBag(remaining);
            setBagUpdatedAt(nowMs());
            setBagDetails((current) => {
              const { [name]: _removed, ...rest } = current;
              return rest;
            });
            setBagWeights((current) => {
              const { [name]: _removed, ...rest } = current;
              return rest;
            });
            if (disc === name) setDisc(remaining[0] ?? '');
          },
        },
      ],
    );
  };

  // Whole grams; clearing the field removes the weight.
  const setDiscWeight = (name: Disc, text: string) => {
    const grams = Number(text.replace(/[^0-9]/g, '').slice(0, 3));
    setBagWeights((current) => {
      const { [name]: _previous, ...rest } = current;
      return grams > 0 ? { ...rest, [name]: grams } : rest;
    });
    setBagUpdatedAt(nowMs());
  };

  const addCatalogDisc = (info: DiscInfo) => {
    const name = bag.includes(info.name) && bagDetails[info.name]?.brand !== info.brand ? `${info.name} (${info.brand})` : info.name;
    if (!bag.includes(name)) setBag((current) => [...current, name]);
    setBagDetails((current) => ({ ...current, [name]: info }));
    setBagUpdatedAt(nowMs());
    setDisc(name);
    setBagEntry('');
  };

  // Layout list, rename and add; used by Course builder and the new-course flow.
  const renderLayoutsEditor = (base: Course, view: CourseView) => {
    const viewLayouts = courseLayouts(base);
    return <>
    <View style={styles.mapEditorHeading}><Text style={styles.builderSectionTitle}>Layouts</Text><Text style={styles.mapProgress}>{viewLayouts.length} {viewLayouts.length === 1 ? 'LAYOUT' : 'LAYOUTS'}</Text></View>
    <Text style={styles.mapInstruction}>Each layout has its own holes, tees, baskets and pars, such as different tee pads or pin positions. The selected layout is the one you map, edit and play.</Text>
    {viewLayouts.map((layout) => {
      const stats = courseStats(withLayout(base, layout.id));
      const selected = view.layoutId === layout.id;
      return <View key={layout.id} style={[styles.courseItem, selected && styles.courseItemSelected]}>
        <Pressable onPress={() => selectLayout(layout.id)} style={styles.courseItemSelect} accessibilityRole="button" accessibilityState={{ selected }}>
          <View style={styles.courseItemCopy}>
            <Text style={styles.courseItemName}>{layoutDisplayName(layout)}</Text>
            <Text style={styles.courseItemMeta}>{[`${stats.holes} ${stats.holes === 1 ? 'hole' : 'holes'}`, stats.parHoles ? `Par ${stats.par}` : null, `${stats.mappedHoles} mapped`].filter(Boolean).join(' · ')}</Text>
          </View>
          <Text style={styles.courseSelectedMark}>{selected ? '✓' : '○'}</Text>
        </Pressable>
        {layout.id !== MAIN_LAYOUT_ID && <Pressable onPress={() => deleteLayout(base, layout)} style={styles.deleteButton} accessibilityRole="button" accessibilityLabel={`Delete the ${layoutDisplayName(layout)} layout`}><Text style={styles.deleteButtonText}>DELETE</Text></Pressable>}
      </View>;
    })}
    <Text style={[styles.builderLabel, styles.detailLabel]}>SELECTED LAYOUT NAME</Text>
    <TextInput value={viewLayouts.find((layout) => layout.id === view.layoutId)?.name ?? ''} onChangeText={(name) => updateCourseLayout(view.id, view.layoutId, (layout) => ({ ...layout, name }))} placeholder={view.layoutId === MAIN_LAYOUT_ID ? 'Main' : 'Layout name'} placeholderTextColor="#5f6a63" style={styles.builderInput} />
    <Text style={[styles.builderLabel, styles.detailLabel]}>NEW LAYOUT</Text>
    <TextInput value={newLayoutName} onChangeText={setNewLayoutName} placeholder="e.g. Blue tees or Winter pins" placeholderTextColor="#5f6a63" style={styles.builderInput} />
    <View style={styles.courseLinks}>
      <Pressable onPress={() => addLayout(true)} style={styles.courseLink}><Text style={styles.courseLinkText}>+ COPY OF {view.layoutLabel.toUpperCase()}</Text></Pressable>
      <Pressable onPress={() => addLayout(false)} style={styles.courseLink}><Text style={styles.courseLinkText}>+ BLANK LAYOUT</Text></Pressable>
    </View>
    </>;
  };

  // Address, contact details, info to know, and the quick-action links.
  const renderDetailsFields = (view: CourseView) => <>
    <Text style={styles.builderLabel}>STREET</Text>
    <TextInput value={courseStreet(view)} onChangeText={(street) => updateCourseDetails(view.id, { street, address: undefined })} placeholder="123 Park Road" placeholderTextColor="#5f6a63" style={styles.builderInput} textContentType="streetAddressLine1" />
    <View style={styles.cityStateRow}>
      <View style={styles.cityField}>
        <Text style={[styles.builderLabel, styles.detailLabel]}>CITY</Text>
        <TextInput value={view.city ?? ''} onChangeText={(city) => updateCourseDetails(view.id, { city })} placeholder="City" placeholderTextColor="#5f6a63" style={styles.builderInput} textContentType="addressCity" />
      </View>
      <View style={styles.stateField}>
        <Text style={[styles.builderLabel, styles.detailLabel]}>STATE</Text>
        <TextInput value={view.state ?? ''} onChangeText={(state) => updateCourseDetails(view.id, { state: state.toUpperCase() })} placeholder="ST" placeholderTextColor="#5f6a63" style={styles.builderInput} autoCapitalize="characters" autoCorrect={false} maxLength={2} textContentType="addressState" />
      </View>
    </View>
    <Text style={[styles.builderLabel, styles.detailLabel]}>PHONE</Text>
    <TextInput value={view.phone ?? ''} onChangeText={(phone) => updateCourseDetails(view.id, { phone: formatPhone(phone) })} placeholder="(555) 123-4567" placeholderTextColor="#5f6a63" style={styles.builderInput} keyboardType="phone-pad" textContentType="telephoneNumber" />
    <Text style={[styles.builderLabel, styles.detailLabel]}>EMAIL</Text>
    <TextInput value={view.email ?? ''} onChangeText={(email) => updateCourseDetails(view.id, { email })} placeholder="contact@example.com" placeholderTextColor="#5f6a63" style={styles.builderInput} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} textContentType="emailAddress" />
    <Text style={[styles.builderLabel, styles.detailLabel]}>WEBSITE</Text>
    <TextInput value={view.website ?? ''} onChangeText={(website) => updateCourseDetails(view.id, { website })} placeholder="udisc.com/courses/…" placeholderTextColor="#5f6a63" style={styles.builderInput} keyboardType="url" autoCapitalize="none" autoCorrect={false} textContentType="URL" />
    <Text style={[styles.builderLabel, styles.detailLabel]}>INFO TO KNOW</Text>
    <TextInput value={view.notes ?? ''} onChangeText={(notes) => updateCourseDetails(view.id, { notes })} placeholder="Parking, fees, hours, restrooms, mandos, water hazards…" placeholderTextColor="#5f6a63" style={[styles.builderInput, styles.notesInput]} multiline textAlignVertical="top" />
    {renderCourseLinks(view)}
  </>;

  // Buttons shared with other screens (header, throw editor) need a hold only during a round.
  const RoundButton = (screen === 'Round' ? HoldPressable : Pressable) as typeof HoldPressable;

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={[styles.appFrame, compact && styles.appFrameCompact]}>
        <View style={styles.topline}>
          <RoundButton onPress={() => setScreen('Home')} style={styles.brand} accessibilityRole="button" accessibilityLabel="Glide Path home">
            <Image source={require('./assets/logo-mark.png')} style={styles.brandLogo} accessibilityIgnoresInvertColors />
            <View style={styles.brandCopy}>
              <Text style={styles.brandName}>GLIDE PATH</Text>
              <Text style={styles.brandSub}>FIELD LOG · EST. 2025</Text>
            </View>
          </RoundButton>
          <RoundButton onPress={() => setScreen('Account')} style={[styles.avatar, account && styles.avatarSignedIn]} accessibilityRole="button" accessibilityLabel={account ? `Account: ${account.user.displayName}` : 'Sign in'}>
            <Text style={[styles.avatarText, account && styles.avatarTextSignedIn]}>{account ? initialsFor(account.user.displayName) : '?'}</Text>
          </RoundButton>
        </View>

        <View style={[styles.pageHeading, screen === 'Round' && styles.pageHeadingCompact]}>
          {screen !== 'Round' && <View>
            <Text style={styles.eyebrow}>{screen === 'Home' ? 'DISC GOLF FIELD LOG' : screen === 'HoleWizard' ? `${selectedCourse?.name ?? 'COURSE'}${hasMultipleLayouts ? ` · ${selectedCourse?.layoutLabel}` : ''} · SATELLITE MAP` : screen === 'Practice' ? 'FOCUSED SESSION' : screen === 'Rounds' ? 'PREVIOUS SESSIONS' : screen === 'Account' ? 'SYNC & SHARING' : screen === 'NewCourse' ? `NEW COURSE · STEP ${newCourseStep} OF 4` : screen === 'FindCourses' ? 'COURSE DIRECTORY' : screen === 'RoundDetail' ? (showingRoundSummary ? 'ROUND COMPLETE' : viewedSession ? formatSessionDate(viewedSession).toUpperCase() : 'ROUND') : 'ALL FINISHED ROUNDS'}</Text>
            <Text style={styles.title}>{screen === 'Home' ? 'Ready when you are.' : screen === 'CourseBuilder' ? 'Course builder.' : screen === 'HoleWizard' ? `Hole ${String(builderHole).padStart(2, '0')}.` : screen === 'BagBuilder' ? 'Bag builder.' : screen === 'Practice' ? 'Practice.' : screen === 'Rounds' ? 'Rounds.' : screen === 'Account' ? (account ? 'Your account.' : 'Sign in.') : screen === 'NewCourse' ? ['Name it.', 'Details.', 'Layouts.', 'Map holes.'][newCourseStep - 1] : screen === 'FindCourses' ? 'Find courses.' : screen === 'RoundDetail' ? `${viewedSession?.courseName ?? 'Round'}.` : 'Stats.'}</Text>
          </View>}
          {screen !== 'Home' && (() => {
            const backToRounds = screen === 'RoundDetail' && !showingRoundSummary;
            const backTo: Screen = screen === 'HoleWizard' ? wizardReturn : screen === 'NewCourse' ? 'CourseBuilder' : backToRounds ? 'Rounds' : 'Home';
            const backLabel = screen === 'HoleWizard' && wizardReturn === 'NewCourse' ? '‹ NEW COURSE' : backTo === 'CourseBuilder' ? '‹ COURSES' : backToRounds ? '‹ ROUNDS' : '⌂ MENU';
            return <RoundButton onPress={() => setScreen(backTo)} style={styles.homeButton} accessibilityLabel={`Back to ${backTo === 'NewCourse' ? 'the new course' : backTo === 'CourseBuilder' ? 'course builder' : backToRounds ? 'rounds' : 'the main menu'}`}><Text style={styles.homeButtonText}>{backLabel}</Text></RoundButton>;
          })()}
        </View>

        {screen === 'Home' ? (
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            {sessionActive && <Pressable onPress={() => setScreen('Round')} style={[styles.menuItem, styles.menuItemPrimary, styles.resumeItem]} accessibilityRole="button">
              <Text style={[styles.menuNumber, styles.menuNumberPrimary]}>▶</Text><View style={styles.menuItemCopy}><Text style={[styles.menuTitle, styles.menuTitlePrimary]}>Resume {mode === 'Round' ? 'round' : 'practice'}</Text><Text style={[styles.menuSubtitle, styles.menuSubtitlePrimary]}>{mode === 'Round' ? selectedCourse?.name ?? 'Round' : `${practiceFocus} practice`} · Hole {hole} · {shots.length} {shots.length === 1 ? 'throw' : 'throws'}</Text></View><Text style={[styles.menuArrow, styles.menuArrowPrimary]}>›</Text>
            </Pressable>}
            <View style={styles.menuOptions}>
              <Pressable onPress={() => setScreen('CourseBuilder')} style={styles.menuItem}>
                <Text style={styles.menuNumber}>01</Text><View style={styles.menuItemCopy}><Text style={styles.menuTitle}>Course builder</Text><Text style={styles.menuSubtitle}>Create and choose your courses</Text></View><Text style={styles.menuArrow}>›</Text>
              </Pressable>
              <Pressable onPress={() => setScreen('FindCourses')} style={styles.menuItem}>
                <Text style={styles.menuNumber}>02</Text><View style={styles.menuItemCopy}><Text style={styles.menuTitle}>Find courses</Text><Text style={styles.menuSubtitle}>Search courses other players have mapped</Text></View><Text style={styles.menuArrow}>›</Text>
              </Pressable>
              <Pressable onPress={() => setScreen('BagBuilder')} style={styles.menuItem}>
                <Text style={styles.menuNumber}>03</Text><View style={styles.menuItemCopy}><Text style={styles.menuTitle}>Bag builder</Text><Text style={styles.menuSubtitle}>Add and select your discs</Text></View><Text style={styles.menuArrow}>›</Text>
              </Pressable>
              <Pressable onPress={() => setScreen('Practice')} style={styles.menuItem}>
                <Text style={styles.menuNumber}>04</Text><View style={styles.menuItemCopy}><Text style={styles.menuTitle}>Practice</Text><Text style={styles.menuSubtitle}>{"Choose a focus for today's session"}</Text></View><Text style={styles.menuArrow}>›</Text>
              </Pressable>
              <Pressable onPress={() => setScreen('Rounds')} style={styles.menuItem}>
                <Text style={styles.menuNumber}>05</Text><View style={styles.menuItemCopy}><Text style={styles.menuTitle}>Rounds</Text><Text style={styles.menuSubtitle}>{history.length ? `${history.length} previous ${history.length === 1 ? 'session' : 'sessions'}` : 'Review your previous rounds'}</Text></View><Text style={styles.menuArrow}>›</Text>
              </Pressable>
              <Pressable onPress={() => setScreen('Insights')} style={styles.menuItem}>
                <Text style={styles.menuNumber}>06</Text><View style={styles.menuItemCopy}><Text style={styles.menuTitle}>Stats</Text><Text style={styles.menuSubtitle}>Scores, putting, drives and discs</Text></View><Text style={styles.menuArrow}>›</Text>
              </Pressable>
              <Pressable onPress={startRound} style={[styles.menuItem, !sessionActive && styles.menuItemPrimary]}>
                <Text style={[styles.menuNumber, !sessionActive && styles.menuNumberPrimary]}>07</Text><View style={styles.menuItemCopy}><Text style={[styles.menuTitle, !sessionActive && styles.menuTitlePrimary]}>{sessionActive ? 'Start a new round' : 'Start a round'}</Text><Text style={[styles.menuSubtitle, !sessionActive && styles.menuSubtitlePrimary]}>Track throws hole by hole</Text></View><Text style={[styles.menuArrow, !sessionActive && styles.menuArrowPrimary]}>↗</Text>
              </Pressable>
            </View>
          </ScrollView>
        ) : screen === 'CourseBuilder' ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Pressable onPress={startNewCourse} style={[styles.primaryButton, styles.newCourseButton]} accessibilityRole="button"><Text style={styles.primaryButtonText}>+ NEW COURSE</Text></Pressable>
            <Text style={styles.builderHint}>Name it, add its details and layouts, then map each layout’s holes.</Text>
            <Text style={styles.builderSectionTitle}>Your courses</Text>
            {courses.map((course) => <View key={course.id} style={[styles.courseItem, selectedCourseId === course.id && styles.courseItemSelected]}><Pressable onPress={() => { if (course.id !== selectedCourseId) setSelectedLayoutId(MAIN_LAYOUT_ID); setSelectedCourseId(course.id); setBuilderHole(1); }} style={styles.courseItemSelect}><View style={styles.courseItemCopy}><Text style={styles.courseItemName}>{course.name}</Text><Text style={styles.courseItemMeta}>{courseLayouts(course).length > 1 ? `${courseLayouts(course).length} layouts` : `${course.holes} holes`} · {selectedCourseId === course.id ? 'Selected' : 'Tap to select'}</Text></View><Text style={styles.courseSelectedMark}>{selectedCourseId === course.id ? '✓' : '○'}</Text></Pressable><Pressable onPress={() => deleteCourse(course)} accessibilityRole="button" accessibilityLabel={`Delete ${course.name}`} style={styles.deleteButton}><Text style={styles.deleteButtonText}>DELETE</Text></Pressable></View>)}
            {selectedBaseCourse && selectedCourse && <View style={styles.mapEditor}>
              {renderLayoutsEditor(selectedBaseCourse, selectedCourse)}
            </View>}
            {selectedCourse && <View style={styles.mapEditor}>
              <Text style={styles.builderSectionTitle}>Course details</Text>
              <View style={styles.toggleRow}>
                <View style={styles.toggleCopy}>
                  <Text style={styles.courseItemName}>Publish to course directory</Text>
                  <Text style={styles.courseItemMeta}>{!account ? 'Sign in to publish this course.' : selectedCourse.published ? (selectedCourse.uid && !pendingChanges ? 'Anyone can find this course, its details, and its tee and basket positions.' : 'Publishing on next sync…') : 'Only you can see this course.'}</Text>
                </View>
                {account
                  ? <Switch value={Boolean(selectedCourse.published)} onValueChange={(published) => setCoursePublished(selectedCourse.id, published)} trackColor={{ true: GREEN }} accessibilityLabel="Publish to course directory" />
                  : <Pressable onPress={() => setScreen('Account')} style={styles.courseLink}><Text style={styles.courseLinkText}>SIGN IN</Text></Pressable>}
              </View>
              {account && selectedCourse.published && selectedCourse.uid ? <Pressable onPress={() => shareLink(`${selectedCourse.name} on Glide Path:`, courseShareUrl(selectedCourse.uid!))} style={[styles.courseLink, styles.toggleAction]}><Text style={styles.courseLinkText}>SHARE COURSE LINK</Text></Pressable> : null}
              {hasMultipleLayouts && <Text style={styles.courseItemMeta}>Stats for the {selectedCourse.layoutLabel} layout</Text>}
              {selectedCourseStats && <View style={styles.courseStatsGrid}>
                <View style={styles.courseStat}><Text style={styles.statLabel}>HOLES</Text><Text style={styles.courseStatValue}>{selectedCourseStats.holes}</Text><Text style={styles.courseStatNote}>{selectedCourseStats.mappedHoles} mapped</Text></View>
                <View style={styles.courseStat}><Text style={styles.statLabel}>PAR</Text><Text style={styles.courseStatValue}>{selectedCourseStats.parHoles ? selectedCourseStats.par : '—'}</Text><Text style={styles.courseStatNote}>{selectedCourseStats.parHoles === selectedCourseStats.holes ? 'All holes' : `${selectedCourseStats.parHoles} of ${selectedCourseStats.holes} holes set`}</Text></View>
                <View style={styles.courseStat}><Text style={styles.statLabel}>DISTANCE</Text><Text style={styles.courseStatValue}>{selectedCourseStats.mappedHoles ? `${selectedCourseStats.distanceFeet.toLocaleString()} ft` : '—'}</Text><Text style={styles.courseStatNote}>Tee to basket, mapped holes</Text></View>
                <View style={styles.courseStat}><Text style={styles.statLabel}>ELEVATION CHANGE</Text><Text style={styles.courseStatValue}>{selectedCourseStats.elevationFeet === null ? '—' : `${selectedCourseStats.elevationFeet} ft`}</Text><Text style={styles.courseStatNote}>{selectedCourseStats.elevationFeet === null ? 'Save tee and basket points to measure' : 'Highest to lowest point'}</Text></View>
              </View>}
              {renderDetailsFields(selectedCourse)}
            </View>}
            {selectedCourse && <View style={styles.mapEditor}><View style={styles.mapEditorHeading}><Text style={styles.builderSectionTitle}>Map holes</Text><Text style={styles.mapProgress}>{mappedHoleCount}/{selectedCourse.holes} MAPPED</Text></View><Text style={styles.mapInstruction}>Map each hole with satellite imagery and on-site GPS capture.</Text><Pressable onPress={() => mapLayout(selectedBaseCourse!, selectedCourse.layoutId, 'CourseBuilder')} style={styles.primaryButton}><Text style={styles.primaryButtonText}>{hasMultipleLayouts ? `MAP ${selectedCourse.layoutLabel.toUpperCase()} LAYOUT ↗` : 'MAP SELECTED COURSE ↗'}</Text></Pressable>
              <View style={[styles.mapEditorHeading, styles.parEditorHeading]}><Text style={styles.builderSectionTitle}>Hole pars{hasMultipleLayouts ? ` · ${selectedCourse.layoutLabel}` : ''}</Text><Text style={styles.mapProgress}>PAR {selectedCourse.layouts?.reduce((sum, layout) => sum + (layout.par ?? 0), 0) ?? 0}</Text></View>
              {Array.from({ length: selectedCourse.holes }, (_, index) => {
                const layout = selectedCourse.layouts?.[index];
                const par = layout?.par;
                const holeNumber = index + 1;
                return <View key={holeNumber} style={styles.parRow}>
                  <View style={styles.courseItemCopy}><Text style={styles.courseItemName}>Hole {String(holeNumber).padStart(2, '0')}</Text><Text style={styles.courseItemMeta}>{layout?.tee && layout.basket ? [`Mapped · ${holeDistanceFeet(layout)} ft`, holeElevationFeet(layout) === null ? null : formatElevation(holeElevationFeet(layout)!)].filter(Boolean).join(' · ') : 'Not mapped'}</Text></View>
                  <Pressable onPress={() => setHolePar(par === undefined ? 3 : Math.max(PAR_OPTIONS[0], par - 1), holeNumber)} style={styles.parStepButton} accessibilityRole="button" accessibilityLabel={`Lower par for hole ${holeNumber}`}><Text style={styles.parStepText}>−</Text></Pressable>
                  <Text style={styles.parStepValue}>{par ?? '—'}</Text>
                  <Pressable onPress={() => setHolePar(par === undefined ? 3 : Math.min(PAR_OPTIONS[PAR_OPTIONS.length - 1], par + 1), holeNumber)} style={styles.parStepButton} accessibilityRole="button" accessibilityLabel={`Raise par for hole ${holeNumber}`}><Text style={styles.parStepText}>+</Text></Pressable>
                  <Pressable onPress={() => deleteHole(selectedCourse, holeNumber)} style={styles.deleteButton} accessibilityRole="button" accessibilityLabel={`Delete hole ${holeNumber}`}><Text style={styles.deleteButtonText}>DELETE</Text></Pressable>
                </View>;
              })}
              <Pressable onPress={() => addHoleToCourse(selectedCourse.id)} style={styles.addHoleButton} accessibilityRole="button"><Text style={styles.addHoleButtonText}>+ ADD HOLE</Text></Pressable>
            </View>}
            <Text style={styles.builderFootnote}>Coordinates are captured only when you save a point. Glide Path does not track your location in the background.</Text>
          </ScrollView>
        ) : screen === 'NewCourse' ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.stepDots} accessibilityLabel={`Step ${newCourseStep} of 4`}>
              {['NAME', 'DETAILS', 'LAYOUTS', 'MAP HOLES'].map((label, index) => <View key={label} style={styles.stepDot}>
                <View style={[styles.stepDotMark, index + 1 <= newCourseStep && styles.stepDotMarkDone]} />
                <Text style={[styles.stepDotLabel, index + 1 === newCourseStep && styles.stepDotLabelCurrent]}>{label}</Text>
              </View>)}
            </View>
            {newCourseStep === 1 ? <View style={styles.builderPanel}>
              <Text style={styles.builderLabel}>COURSE NAME</Text>
              <TextInput value={courseName} onChangeText={setCourseName} onSubmitEditing={saveNewCourseName} placeholder="e.g. Cedar Grove" placeholderTextColor="#5f6a63" style={styles.builderInput} returnKeyType="next" autoFocus />
            </View> : !selectedBaseCourse || !selectedCourse || selectedBaseCourse.id !== newCourseId ? <Text style={styles.mapInstruction}>This course is no longer available.</Text>
              : newCourseStep === 2 ? <View style={styles.builderPanel}>
                <Text style={styles.mapInstruction}>All optional. You can change these any time in Course builder.</Text>
                {renderDetailsFields(selectedCourse)}
              </View>
              : newCourseStep === 3 ? <View>
                <Text style={styles.mapInstruction}>Name the first layout (for example Main or Red tees), then add any others: different tee pads, pin positions or seasonal setups.</Text>
                {renderLayoutsEditor(selectedBaseCourse, selectedCourse)}
              </View>
              : <View>
                <Text style={styles.mapInstruction}>Map each layout by walking to every tee and basket. Holes are added as you go: on the last hole, + ADD HOLE adds the next one.</Text>
                {courseLayouts(selectedBaseCourse).map((layout) => {
                  const stats = courseStats(withLayout(selectedBaseCourse, layout.id));
                  return <View key={layout.id} style={styles.courseItem}>
                    <View style={[styles.courseItemCopy, styles.layoutMapCopy]}>
                      <Text style={styles.courseItemName}>{layoutDisplayName(layout)}</Text>
                      <Text style={styles.courseItemMeta}>{stats.mappedHoles ? `${stats.mappedHoles} of ${stats.holes} ${stats.holes === 1 ? 'hole' : 'holes'} mapped` : 'Not mapped yet'}</Text>
                    </View>
                    <Pressable onPress={() => mapLayout(selectedBaseCourse, layout.id, 'NewCourse')} style={styles.courseLink} accessibilityRole="button" accessibilityLabel={`Map the ${layoutDisplayName(layout)} layout`}><Text style={styles.courseLinkText}>{stats.mappedHoles ? 'CONTINUE ↗' : 'MAP ↗'}</Text></Pressable>
                  </View>;
                })}
              </View>}
            <View style={styles.wizardNavigation}>
              {newCourseStep > 1
                ? <Pressable onPress={() => setNewCourseStep((newCourseStep - 1) as 1 | 2 | 3)} style={styles.wizardNavButton}><Text style={styles.wizardNavText}>‹ BACK</Text></Pressable>
                : <Pressable onPress={() => setScreen('CourseBuilder')} style={styles.wizardNavButton}><Text style={styles.wizardNavText}>CANCEL</Text></Pressable>}
              {newCourseStep === 1
                ? <Pressable onPress={saveNewCourseName} disabled={!courseName.trim()} style={[styles.wizardNavButton, styles.wizardNavNext, !courseName.trim() && styles.disabledButton]}><Text style={[styles.wizardNavText, styles.wizardNavNextText]}>NEXT: DETAILS ›</Text></Pressable>
                : newCourseStep < 4
                  ? <Pressable onPress={() => setNewCourseStep((newCourseStep + 1) as 3 | 4)} style={[styles.wizardNavButton, styles.wizardNavNext]}><Text style={[styles.wizardNavText, styles.wizardNavNextText]}>{newCourseStep === 2 ? 'NEXT: LAYOUTS ›' : 'NEXT: MAP HOLES ›'}</Text></Pressable>
                  : <Pressable onPress={() => setScreen('CourseBuilder')} style={[styles.wizardNavButton, styles.wizardNavNext]}><Text style={[styles.wizardNavText, styles.wizardNavNextText]}>DONE ✓</Text></Pressable>}
            </View>
          </ScrollView>
        ) : screen === 'HoleWizard' ? (
          <View style={styles.holeWizard}>
            <View style={styles.wizardProgress}><View><Text style={styles.editorHoleName}>HOLE {String(builderHole).padStart(2, '0')} OF {String(selectedCourse?.holes ?? 0).padStart(2, '0')}</Text><Text style={[styles.mapProgress, styles.wizardMappedCount]}>{mappedHoleCount}/{selectedCourse?.holes ?? 0} MAPPED</Text></View>{selectedCourse && <Pressable onPress={() => deleteHole(selectedCourse, builderHole)} accessibilityRole="button" accessibilityLabel={`Delete hole ${builderHole}`} style={styles.deleteHoleButton}><Text style={styles.deleteButtonText}>DELETE HOLE</Text></Pressable>}</View>
            <View style={styles.satelliteFrame} onLayout={(event) => setMapViewportWidth(event.nativeEvent.layout.width)}>
              {mapRegion ? <MapView style={styles.satelliteMap} mapType="satellite" region={mapRegion} onRegionChangeComplete={setMapRegion} showsUserLocation={locationAllowed} showsMyLocationButton={false}>
                {editorHoleLayout?.tee && <Marker coordinate={editorHoleLayout.tee} title={`Hole ${builderHole} tee box`} description={`GPS accuracy ${editorHoleLayout.tee.accuracy ?? 'unknown'} meters`} pinColor="#1d684c" />}
                {editorHoleLayout?.basket && <BasketCircles basket={editorHoleLayout.basket} />}
                {editorHoleLayout?.basket && <Marker coordinate={editorHoleLayout.basket} title={`Hole ${builderHole} basket`} description={`GPS accuracy ${editorHoleLayout.basket.accuracy ?? 'unknown'} meters`} pinColor="#d77d42" />}
                {editorHoleLayout?.tee && editorHoleLayout.basket && <Polyline coordinates={[editorHoleLayout.tee, editorHoleLayout.basket]} strokeColor="#ffffff" strokeWidth={2} lineDashPattern={[6, 4]} />}
              </MapView> : <View style={styles.mapUnavailable}><Text style={styles.mapUnavailableTitle}>{mapLoading ? 'Finding your location…' : 'Map location unavailable'}</Text><Text style={styles.mapUnavailableText}>{gpsMessage || 'Enable location access to open the satellite map.'}</Text><Pressable onPress={recenterSatelliteMap} style={styles.recenterButton}><Text style={styles.recenterButtonText}>TRY AGAIN</Text></Pressable></View>}
              {mapRegion && <><View pointerEvents="none" style={styles.satelliteBadge}><Text style={styles.satelliteBadgeText}>SATELLITE</Text></View><Pressable onPress={recenterSatelliteMap} style={styles.recenterButton}><Text style={styles.recenterButtonText}>◎ RECENTER</Text></Pressable><View pointerEvents="none" style={styles.mapScaleBadge}><View style={[styles.mapScaleRule, { width: scaleBarWidth }]} /><Text style={styles.mapScaleLabel}>{scaleBarFeet} FT</Text><Text style={styles.mapScaleWidth}>VIEW ≈{Math.round(visibleMapWidthFeet)} FT WIDE</Text></View></>}
            </View>
            <Text style={styles.mapInstruction}>Walk to each point. Save your GPS position when the blue location dot is at the tee or basket.</Text>
            <View style={styles.captureButtons}>
              <Pressable onPress={() => saveCoursePoint('tee')} disabled={savingGpsTarget !== null} style={[styles.captureButton, editorHoleLayout?.tee && styles.captureButtonSaved, savingGpsTarget === 'tee' && styles.disabledButton]}><Text style={styles.captureButtonLabel}>TEE BOX</Text><Text style={styles.captureButtonValue}>{savingGpsTarget === 'tee' ? 'SAVING GPS…' : editorHoleLayout?.tee ? 'UPDATE LOCATION' : 'SAVE LOCATION'}</Text><Text style={styles.captureButtonCoords}>{formatSavedPoint(editorHoleLayout?.tee)}</Text></Pressable>
              <Pressable onPress={() => saveCoursePoint('basket')} disabled={savingGpsTarget !== null} style={[styles.captureButton, editorHoleLayout?.basket && styles.captureButtonSaved, savingGpsTarget === 'basket' && styles.disabledButton]}><Text style={styles.captureButtonLabel}>BASKET</Text><Text style={styles.captureButtonValue}>{savingGpsTarget === 'basket' ? 'SAVING GPS…' : editorHoleLayout?.basket ? 'UPDATE LOCATION' : 'SAVE LOCATION'}</Text><Text style={styles.captureButtonCoords}>{formatSavedPoint(editorHoleLayout?.basket)}</Text></Pressable>
            </View>
            <View style={styles.parPicker}>
              <Text style={styles.holeDistanceLabel}>PAR</Text>
              <View style={styles.parOptions}>
                {PAR_OPTIONS.map((value) => <Pressable key={value} onPress={() => setHolePar(value)} style={[styles.parOption, editorHoleLayout?.par === value && styles.parOptionSelected]} accessibilityRole="button" accessibilityLabel={`Par ${value}`}><Text style={[styles.parOptionText, editorHoleLayout?.par === value && styles.parOptionTextSelected]}>{value}</Text></Pressable>)}
              </View>
            </View>
            {editorHoleDistance !== null && <View style={styles.holeDistance}><Text style={styles.holeDistanceLabel}>TEE TO BASKET</Text><Text style={styles.holeDistanceValue}>{editorHoleDistance} ft{holeElevationFeet(editorHoleLayout) === null ? '' : `  ${formatElevation(holeElevationFeet(editorHoleLayout)!)}`}</Text></View>}
            {gpsMessage ? <Text style={styles.gpsMessage}>{gpsMessage}</Text> : null}
            <View style={styles.wizardNavigation}>
              <Pressable onPress={() => moveWizardHole(builderHole - 1)} disabled={builderHole === 1} style={[styles.wizardNavButton, builderHole === 1 && styles.holeNavDisabled]}><Text style={styles.wizardNavText}>‹ PREVIOUS</Text></Pressable>
              <Pressable onPress={() => setScreen(wizardReturn)} style={[styles.wizardNavButton, styles.wizardNavFinish]}><Text style={styles.wizardNavFinishText}>FINISH ✓</Text></Pressable>
              <Pressable onPress={() => builderHole < (selectedCourse?.holes ?? 1) ? moveWizardHole(builderHole + 1) : addWizardHole()} style={[styles.wizardNavButton, styles.wizardNavNext]}><Text style={[styles.wizardNavText, styles.wizardNavNextText]}>{builderHole < (selectedCourse?.holes ?? 1) ? 'NEXT HOLE ›' : '+ ADD HOLE'}</Text></Pressable>
            </View>
          </View>
        ) : screen === 'BagBuilder' ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.builderPanel}>
              <Text style={styles.builderLabel}>ADD A DISC</Text>
              <View style={styles.addDiscRow}><TextInput value={bagEntry} onChangeText={setBagEntry} onSubmitEditing={addDisc} placeholder="Disc name or mold" placeholderTextColor="#5f6a63" style={[styles.builderInput, styles.discInput]} returnKeyType="done" /><Pressable onPress={addDisc} style={styles.addDiscButton}><Text style={styles.addDiscButtonText}>ADD</Text></Pressable></View>
              {discQuery.length >= DISC_SEARCH_MIN_CHARS && <View style={styles.discResults}>
                {discSearchPending ? <Text style={styles.discResultsNote}>Searching DiscIt…</Text>
                  : discSearch.failed ? <Text style={styles.discResultsNote}>Could not reach DiscIt. Check your connection, or tap ADD to save this name.</Text>
                  : !discResults.length ? <Text style={styles.discResultsNote}>No matches in DiscIt. Tap ADD to save this name as a custom disc.</Text>
                  : discResults.map((item) => <Pressable key={item.id} onPress={() => addCatalogDisc(item)} style={styles.discResult} accessibilityRole="button" accessibilityLabel={`Add ${item.brand} ${item.name}`}><View style={styles.discResultCopy}><Text style={styles.bagItemName}>{item.name}</Text><Text style={styles.bagItemMeta}>{item.brand} · {item.category}</Text></View><Text style={styles.discResultFlight}>{formatFlightNumbers(item)}</Text><Text style={styles.bagArrow}>＋</Text></Pressable>)}
                <Text style={styles.discResultsCredit}>FLIGHT NUMBERS FROM DISCIT API</Text>
              </View>}
            </View>
            <Text style={styles.builderSectionTitle}>Your bag · {bag.length} discs</Text>
            {!bag.length && <Text style={styles.mapInstruction}>Your bag is empty. Search for a disc above to add it.</Text>}
            {bag.map((item, index) => <View key={`${item}-${index}`} style={styles.bagItem}><View style={styles.bagItemSelect}><View style={[styles.discSwatch, { backgroundColor: bagDetails[item]?.background_color ?? ['#e08b48', '#619276', '#8ba4a0', '#d4d1c3'][index % 4] }]}><Text style={[styles.discSwatchText, bagDetails[item]?.color ? { color: bagDetails[item].color } : null]}>{item.charAt(0).toUpperCase()}</Text></View><View style={styles.bagItemCopy}><Text style={styles.bagItemName}>{item}</Text>{bagDetails[item] && <Text style={styles.bagItemMeta}>{formatDiscMeta(bagDetails[item])}</Text>}{shots.some((shot) => shot.disc === item) && <Text style={styles.bagItemMeta}>{shots.filter((shot) => shot.disc === item).length} throws logged</Text>}</View></View><View style={styles.weightField}><TextInput value={bagWeights[item] ? String(bagWeights[item]) : ''} onChangeText={(text) => setDiscWeight(item, text)} placeholder="—" placeholderTextColor="#5f6a63" keyboardType="number-pad" maxLength={3} style={styles.weightInput} accessibilityLabel={`Weight of ${item} in grams`} /><Text style={styles.weightUnit}>g</Text></View><Pressable onPress={() => deleteDisc(item)} accessibilityRole="button" accessibilityLabel={`Remove ${item} from bag`} style={styles.deleteButton}><Text style={styles.deleteButtonText}>DELETE</Text></Pressable></View>)}
          </ScrollView>
        ) : screen === 'Practice' ? (
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.practiceIntro}><Text style={styles.menuIntroLabel}>SET A SESSION FOCUS</Text><Text style={styles.practiceIntroTitle}>What are you working on?</Text><Text style={styles.practiceIntroCopy}>Log throws at {selectedCourse?.name ?? 'your practice area'} and compare the results after your session.</Text></View>
            {['Distance', 'Accuracy', 'Putting'].map((focus) => <Pressable key={focus} onPress={() => setPracticeFocus(focus)} style={[styles.practiceChoice, practiceFocus === focus && styles.practiceChoiceSelected]}><View style={styles.practiceChoiceCopy}><Text style={styles.practiceChoiceTitle}>{focus}</Text><Text style={styles.practiceChoiceSubtitle}>{focus === 'Distance' ? 'Build a baseline for each disc' : focus === 'Accuracy' ? 'Work on landing near your target' : 'Track short throws and touch'}</Text></View><Text style={styles.practiceChoiceMark}>{practiceFocus === focus ? '✓' : '○'}</Text></Pressable>)}
            <Pressable onPress={startPractice} style={styles.primaryButton}><Text style={styles.primaryButtonText}>START {practiceFocus.toUpperCase()} PRACTICE ↗</Text></Pressable>
          </ScrollView>
        ) : screen === 'Round' ? (
          <ScrollView ref={roundScrollRef} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.roundToolbar}>
              <View style={styles.courseLabel}><Text style={styles.holeLabel}>{mode === 'Practice' ? `${practiceFocus.toUpperCase()} PRACTICE` : 'PLAYING AT'}</Text><Text style={styles.courseLabelName}>{selectedCourse?.name ?? 'Practice area'}{hasMultipleLayouts ? ` · ${selectedCourse?.layoutLabel}` : ''}</Text></View>
              <View style={styles.roundHoleNav}>
                <HoldPressable onPress={goToPreviousHole} disabled={hole <= 1} style={[styles.roundHoleArrow, hole <= 1 && styles.holeNavDisabled]} accessibilityRole="button" accessibilityLabel="Previous hole"><Text style={styles.holeNavArrow}>‹</Text></HoldPressable>
                <View style={styles.holeSelector}><Text style={styles.holeLabel}>HOLE</Text><Text style={styles.holeNumber}>{String(hole).padStart(2, '0')}<Text style={styles.holeTotal}> / {selectedCourse?.holes ?? 18}</Text></Text></View>
                <HoldPressable onPress={startNextHole} style={styles.roundHoleArrow} accessibilityRole="button" accessibilityLabel="Next hole"><Text style={styles.holeNavArrow}>›</Text></HoldPressable>
              </View>
            </View>

            {/* Hole and round numbers in one slim strip; practice has no par or round score. */}
            <View style={styles.scoreStrip}>
              {[
                ['HOLE', String(holeStrokes)],
                ['DIST', `${holeFeet} ft`],
                ...(mode === 'Round' ? [
                  ['PAR', String(selectedHoleLayout?.par ?? '—')],
                  ['ROUND', String(roundScore.strokes)],
                  ['TO PAR', roundScore.toPar === null ? '—' : formatScoreToPar(roundScore.toPar)],
                  ['THRU', String(roundScore.holesCompleted)],
                ] : []),
              ].map(([label, value]) => <View key={label} style={styles.scoreStripItem}><Text style={styles.scoreStripLabel}>{label}</Text><Text style={styles.scoreStripValue}>{value}</Text></View>)}
            </View>

            {roundMapRegion ? <View style={styles.roundMapFrame}>
              <MapView key={`${selectedCourse?.id}-${hole}`} style={styles.satelliteMap} mapType="satellite" initialRegion={roundMapRegion} showsUserLocation={locationAllowed} showsMyLocationButton={false}>
                {selectedHoleLayout?.tee && selectedHoleLayout.basket && <Polyline coordinates={[selectedHoleLayout.tee, selectedHoleLayout.basket]} strokeColor="#ffffff" strokeWidth={2} lineDashPattern={[6, 4]} />}
                {throwPath.length > 1 && <Polyline coordinates={throwPath} strokeColor="#df8547" strokeWidth={3} />}
                {selectedHoleLayout?.tee && <Marker coordinate={selectedHoleLayout.tee} title={`Hole ${hole} tee box`} pinColor="#1d684c" />}
                {selectedHoleLayout?.basket && <BasketCircles basket={selectedHoleLayout.basket} />}
                {selectedHoleLayout?.basket && <Marker coordinate={selectedHoleLayout.basket} title={`Hole ${hole} basket`} pinColor="#d77d42" />}
                {mappedShots.map((shot) => <Marker key={`${shot.index}-${shot.coordinate.latitude}`} coordinate={shot.coordinate} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}><View style={styles.shotMarker}><Text style={styles.shotPinText}>{shot.index + 1}</Text></View></Marker>)}
              </MapView>
              <View pointerEvents="none" style={styles.boardCaption}><Text style={styles.boardCaptionText}>{(selectedCourse?.name ?? 'PRACTICE AREA').toUpperCase()}</Text><Text style={styles.boardScale}>SATELLITE</Text></View>
            </View> : <View style={[styles.roundMapFrame, styles.mapUnavailable]}><Text style={styles.mapUnavailableTitle}>Hole not mapped yet</Text><Text style={styles.mapUnavailableText}>Map this hole in Course builder to see it on the satellite map. You can still log throws.</Text></View>}
            {(selectedHoleDistance !== null || lieToBasket || caddie.length > 0) && <View style={[styles.holeDistance, styles.roundHoleDistance, styles.basketDistances]}>
              {selectedHoleDistance !== null && <View style={styles.basketDistanceRow}><Text style={styles.holeDistanceLabel}>TEE TO BASKET</Text><Text style={styles.holeDistanceValue}>{selectedHoleDistance} ft{holeElevationFeet(selectedHoleLayout) === null ? '' : `  ${formatElevation(holeElevationFeet(selectedHoleLayout)!)}`}</Text></View>}
              {lieToBasket && <View style={styles.basketDistanceRow}><Text style={styles.holeDistanceLabel}>YOUR LIE TO BASKET</Text><Text style={styles.holeDistanceValue}>{lieToBasket.feet} ft{lieToBasket.elevation === null ? '' : `  ${formatElevation(lieToBasket.elevation)}`}</Text></View>}
              {caddie.length > 0 && <View style={styles.caddieRow}>
                <Text style={styles.holeDistanceLabel}>CADDIE · {caddieType.toUpperCase()} · {caddieTargetFeet} FT</Text>
                {caddie.map((item) => <Text key={`${item.disc}-${item.style ?? ''}`} style={styles.caddieText}>{item.disc}{item.style ? ` ${item.style.toLowerCase()}` : ''}  <Text style={styles.caddieMeta}>{caddieType === 'Putt' ? `${item.count} ${item.count === 1 ? 'putt' : 'putts'}` : `avg ${item.averageFeet} ft · ${item.count} ${item.count === 1 ? 'throw' : 'throws'}`}</Text></Text>)}
              </View>}
            </View>}

            <HoldPressable onPress={startLogThrow} disabled={loggingThrow} style={[styles.logThrowButton, loggingThrow && styles.disabledButton]} accessibilityRole="button"><Text style={styles.logThrowButtonText}>{loggingThrow ? 'GETTING GPS…' : `LOG THROW ${score + 1}`}</Text><Text style={styles.logThrowButtonHint}>Stand where your disc landed, then press and hold</Text></HoldPressable>
            {roundMessage ? <Text style={styles.gpsMessage}>{roundMessage}</Text> : null}

            <View style={styles.latestRow}>
              <HoldPressable onPress={() => latestShot && openActiveThrowEditor(latestShot)} disabled={!latestShot} style={styles.latestCopy} accessibilityRole="button" accessibilityHint="Opens the throw to change its details"><Text style={styles.latestEyebrow}>LATEST THROW{latestShot ? '  ·  HOLD TO EDIT' : ''}</Text><Text style={styles.latestText}>{latestShot ? [latestShot.feet ? `${latestShot.feet} ft` : 'Distance n/a', [latestShot.disc || 'No disc', latestShot.style?.toLowerCase(), latestShot.type.toLowerCase()].filter(Boolean).join(' '), formatLie(latestShot.lie), latestShot.quality ? `quality ${formatQuality(latestShot)}` : null].filter(Boolean).join(' · ') : 'Walk to your disc and hold Log throw'}</Text></HoldPressable>
              {activeShots.length > 0 && <HoldPressable accessibilityLabel="Undo last throw" onPress={undoLastThrow} style={styles.undoButton}><Text style={styles.undoText}>UNDO</Text></HoldPressable>}
            </View>
            <HoldPressable onPress={finishHole} style={styles.finishButton}><Text style={styles.finishButtonText}>{mode === 'Practice' ? 'NEXT TARGET' : 'FINISH HOLE'} <Text style={styles.finishArrow}>↗</Text></Text></HoldPressable>
            <HoldPressable onPress={endSession} style={styles.endSessionButton} accessibilityRole="button"><Text style={styles.endSessionText}>END {mode === 'Round' ? 'ROUND' : 'PRACTICE'}</Text></HoldPressable>
            {selectedCourse ? <View style={styles.roundCourseInfo}>
              <HoldPressable onPress={() => setShowCourseInfo((current) => !current)} style={styles.roundCourseInfoHeader} accessibilityRole="button" accessibilityState={{ expanded: showCourseInfo }}>
                <Text style={styles.sectionTitle}>Course info</Text><Text style={styles.menuArrow}>{showCourseInfo ? '−' : '+'}</Text>
              </HoldPressable>
              {showCourseInfo && <>
                {selectedCourseStats && <Text style={styles.roundCourseInfoText}>{[
                  `${selectedCourseStats.holes} ${selectedCourseStats.holes === 1 ? 'hole' : 'holes'}`,
                  selectedCourseStats.parHoles ? `Par ${selectedCourseStats.par}` : null,
                  selectedCourseStats.mappedHoles ? `${selectedCourseStats.distanceFeet.toLocaleString()} ft` : null,
                  selectedCourseStats.elevationFeet === null ? null : `${selectedCourseStats.elevationFeet} ft elevation change`,
                ].filter(Boolean).join(' · ')}</Text>}
                {courseAddressLine(selectedCourse) ? <Text style={styles.roundCourseInfoText}>{courseAddressLine(selectedCourse)}</Text> : null}
                {selectedCourse.phone?.trim() ? <Text style={styles.roundCourseInfoText}>{selectedCourse.phone}</Text> : null}
                {selectedCourse.notes?.trim() ? <><Text style={[styles.fieldLabel, styles.roundCourseNotesLabel]}>INFO TO KNOW</Text><Text style={styles.roundCourseNotes}>{selectedCourse.notes.trim()}</Text></> : null}
                {renderCourseLinks(selectedCourse)}
              </>}
            </View> : null}
            <Text style={styles.footnote}>{selectedHoleLayout?.tee ? 'Distances are measured by GPS from the tee or your previous lie.' : 'Map this hole’s tee in Course builder to measure your first throw. Later throws are measured from your previous lie.'}</Text>
          </ScrollView>
        ) : screen === 'Account' ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {account ? <>
              <View style={styles.menuIntro}>
                <Text style={styles.menuIntroLabel}>SIGNED IN AS</Text>
                <Text style={styles.menuIntroTitle}>{account.user.displayName}</Text>
                <Text style={styles.menuIntroCopy}>{account.user.email}</Text>
              </View>
              <View style={styles.builderPanel}>
                <Text style={styles.builderLabel}>SYNC</Text>
                <Text style={styles.accountStatus}>{syncing ? 'Syncing…' : account.lastSyncedAt ? `Last synced ${formatSyncTime(account.lastSyncedAt)}` : 'Not synced yet'}</Text>
                <Text style={styles.courseItemMeta}>{pendingChanges ? `${pendingChanges} ${pendingChanges === 1 ? 'change' : 'changes'} waiting to upload` : 'Everything on this phone is backed up.'}</Text>
                {syncError ? <Text style={styles.authError}>{syncError}</Text> : null}
                <Pressable onPress={runSync} disabled={syncing} style={[styles.primaryButton, syncing && styles.disabledButton]}><Text style={styles.primaryButtonText}>{syncing ? 'SYNCING…' : 'SYNC NOW'}</Text></Pressable>
              </View>
              <Text style={styles.mapInstruction}>Your courses, rounds and bag sync automatically when the app opens and shortly after changes. Published courses and shared rounds are public; everything else is private to your account.</Text>
              <Pressable onPress={confirmSignOut} style={styles.endSessionButton}><Text style={styles.undoText}>SIGN OUT</Text></Pressable>
              <Pressable onPress={confirmDeleteAccount} style={styles.endSessionButton}><Text style={styles.endSessionText}>DELETE ACCOUNT</Text></Pressable>
            </> : <>
              <View style={styles.menuIntro}>
                <Text style={styles.menuIntroLabel}>BACK UP AND SHARE</Text>
                <Text style={styles.menuIntroCopy}>Sign in to back up your courses, rounds and bag, keep them in sync across devices, publish courses to the directory, and share rounds. Glide Path keeps working offline and syncs when you’re back online.</Text>
              </View>
              {syncError ? <Text style={styles.authError}>{syncError}</Text> : null}
              {authMode === 'signIn' || authMode === 'register' ? <View style={[styles.typeRow, styles.authTabs]}>
                {(['signIn', 'register'] as const).map((item) => <Pressable key={item} onPress={() => switchAuthMode(item)} style={[styles.typeButton, styles.sheetTypeButton, authMode === item && styles.typeButtonSelected]}><Text style={[styles.typeText, authMode === item && styles.typeTextSelected]}>{item === 'signIn' ? 'Sign in' : 'Create account'}</Text></Pressable>)}
              </View> : <Pressable onPress={() => switchAuthMode('signIn')} style={styles.backLink}><Text style={styles.homeButtonText}>‹ BACK TO SIGN IN</Text></Pressable>}
              <View style={styles.builderPanel}>
                {authMode === 'forgot' && <Text style={styles.authIntro}>Enter your account’s email and we’ll send a code to reset your password.</Text>}
                {authNotice ? <Text style={styles.authNotice}>{authNotice}</Text> : null}
                {authMode === 'register' && <>
                  <Text style={styles.builderLabel}>NAME</Text>
                  <TextInput value={authName} onChangeText={setAuthName} placeholder="Shown on courses you publish" placeholderTextColor="#5f6a63" style={styles.builderInput} textContentType="name" autoComplete="name" />
                </>}
                <Text style={[styles.builderLabel, authMode === 'register' && styles.detailLabel]}>EMAIL</Text>
                <TextInput value={authEmail} onChangeText={setAuthEmail} placeholder="you@example.com" placeholderTextColor="#5f6a63" style={styles.builderInput} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} textContentType="emailAddress" autoComplete="email" />
                {authMode === 'reset' && <>
                  <Text style={[styles.builderLabel, styles.detailLabel]}>CODE FROM THE EMAIL</Text>
                  <TextInput value={resetCode} onChangeText={(text) => setResetCode(text.replace(/[^0-9]/g, '').slice(0, 6))} placeholder="6 digits" placeholderTextColor="#5f6a63" style={[styles.builderInput, styles.codeInput]} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" maxLength={6} />
                </>}
                {authMode !== 'forgot' && <>
                  <Text style={[styles.builderLabel, styles.detailLabel]}>{authMode === 'reset' ? 'NEW PASSWORD' : 'PASSWORD'}</Text>
                  <TextInput value={authPassword} onChangeText={setAuthPassword} onSubmitEditing={submitAuth} placeholder={authMode === 'signIn' ? 'Password' : 'At least 8 characters'} placeholderTextColor="#5f6a63" style={styles.builderInput} secureTextEntry textContentType={authMode === 'signIn' ? 'password' : 'newPassword'} autoComplete={authMode === 'signIn' ? 'current-password' : 'new-password'} returnKeyType="go" />
                </>}
                {authError ? <Text style={styles.authError}>{authError}</Text> : null}
                <Pressable onPress={submitAuth} disabled={authBusy} style={[styles.primaryButton, authBusy && styles.disabledButton]}><Text style={styles.primaryButtonText}>{authBusy ? 'PLEASE WAIT…' : { signIn: 'SIGN IN', register: 'CREATE ACCOUNT', forgot: 'SEND RESET CODE', reset: 'RESET PASSWORD & SIGN IN' }[authMode]}</Text></Pressable>
                {authBusy && <Text style={styles.builderHint}>The server can take up to a minute to wake if it hasn’t been used recently.</Text>}
                {authMode === 'signIn' && <Pressable onPress={() => switchAuthMode('forgot')} style={styles.textLink}><Text style={styles.textLinkText}>Forgot password?</Text></Pressable>}
                {authMode === 'reset' && <Pressable onPress={sendResetCode} disabled={authBusy} style={styles.textLink}><Text style={styles.textLinkText}>Send a new code</Text></Pressable>}
              </View>
              <Text style={styles.builderFootnote}>Your existing courses, rounds and bag upload the first time you sign in.</Text>
            </>}
            <Text style={styles.serverNote}>SERVER · {API_URL.replace(/^https?:\/\//, '')}</Text>
          </ScrollView>
        ) : screen === 'FindCourses' ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {publicCourse ? <>
              <Pressable onPress={() => setPublicCourse(null)} style={styles.backLink}><Text style={styles.homeButtonText}>‹ RESULTS</Text></Pressable>
              <View style={styles.finalScore}>
                <Text style={styles.menuIntroLabel}>MAPPED BY {publicCourse.mappedBy.toUpperCase()}</Text>
                <Text style={styles.menuIntroTitle}>{publicCourse.name}</Text>
                <Text style={styles.menuIntroCopy}>{[
                  `${publicCourse.holes} ${publicCourse.holes === 1 ? 'hole' : 'holes'}`,
                  publicCourse.par === null ? null : `Par ${publicCourse.par}`,
                  publicCourse.mappedHoles ? `${publicCourse.distanceFeet.toLocaleString()} ft` : null,
                  `${publicCourse.mappedHoles} mapped`,
                  publicCourse.extraLayouts?.length ? `${publicCourse.extraLayouts.length + 1} layouts` : null,
                ].filter(Boolean).join(' · ')}</Text>
                {courseAddressLine(publicCourse.details) ? <Text style={styles.menuIntroCopy}>{courseAddressLine(publicCourse.details)}</Text> : null}
              </View>
              {publicCourse.details.notes?.trim() ? <><Text style={styles.fieldLabel}>INFO TO KNOW</Text><Text style={styles.roundCourseNotes}>{publicCourse.details.notes.trim()}</Text></> : null}
              {courses.some((course) => course.sourceUid === publicCourse.uid || course.uid === publicCourse.uid)
                ? <View style={[styles.primaryButton, styles.disabledButton]}><Text style={styles.primaryButtonText}>IN YOUR COURSES ✓</Text></View>
                : <Pressable onPress={() => addPublicCourse(publicCourse)} style={styles.primaryButton}><Text style={styles.primaryButtonText}>ADD TO MY COURSES</Text></Pressable>}
              <Pressable onPress={() => shareLink(`${publicCourse.name} on Glide Path:`, courseShareUrl(publicCourse.uid))} style={[styles.courseLink, styles.toggleAction]}><Text style={styles.courseLinkText}>SHARE COURSE LINK</Text></Pressable>
            </> : <>
              <View style={styles.builderPanel}>
                <Text style={styles.builderLabel}>COURSE, CITY OR STATE</Text>
                <View style={styles.addDiscRow}>
                  <TextInput value={findQuery} onChangeText={setFindQuery} onSubmitEditing={() => runCourseSearch(false)} placeholder="e.g. Cedar Grove or PA" placeholderTextColor="#5f6a63" style={[styles.builderInput, styles.discInput]} returnKeyType="search" />
                  <Pressable onPress={() => runCourseSearch(false)} disabled={findBusy} style={[styles.addDiscButton, findBusy && styles.disabledButton]}><Text style={styles.addDiscButtonText}>SEARCH</Text></Pressable>
                </View>
                <Pressable onPress={() => runCourseSearch(true)} disabled={findBusy} style={[styles.courseLink, styles.toggleAction, findBusy && styles.disabledButton]}><Text style={styles.courseLinkText}>◎ COURSES NEAR ME</Text></Pressable>
              </View>
              {findBusy ? <Text style={styles.mapInstruction}>Searching… The server can take up to a minute to wake if it hasn’t been used recently.</Text> : null}
              {findError ? <Text style={styles.authError}>{findError}</Text> : null}
              {!findBusy && findResults === null && !findError ? <Text style={styles.mapInstruction}>Find courses other Glide Path players have mapped and published, then add them to your courses to play.</Text> : null}
              {!findBusy && findResults?.length === 0 ? <Text style={styles.mapInstruction}>No published courses found{findNearby ? ' near you' : ''} yet.</Text> : null}
              {findResults?.map((result) => <Pressable key={result.uid} onPress={() => openPublicCourse(result.uid)} disabled={publicCourseLoading !== null} style={styles.courseItem} accessibilityRole="button">
                <View style={styles.courseItemCopy}>
                  <Text style={styles.courseItemName}>{result.name}</Text>
                  <Text style={styles.courseItemMeta}>{[
                    [result.city, result.state].filter(Boolean).join(', ') || null,
                    `${result.holes} ${result.holes === 1 ? 'hole' : 'holes'}`,
                    result.par === null ? null : `Par ${result.par}`,
                    result.layoutCount > 1 ? `${result.layoutCount} layouts` : null,
                    result.distanceMiles === null ? null : `${result.distanceMiles} mi`,
                  ].filter(Boolean).join(' · ')}</Text>
                  <Text style={styles.courseItemMeta}>Mapped by {result.mappedBy}</Text>
                </View>
                <Text style={styles.menuArrow}>{publicCourseLoading === result.uid ? '…' : '›'}</Text>
              </Pressable>)}
            </>}
          </ScrollView>
        ) : screen === 'Rounds' ? (
          <ScrollView contentContainerStyle={styles.content}>
            {!pastSessions.length && <View style={styles.menuIntro}><Text style={styles.menuIntroLabel}>NO ROUNDS YET</Text><Text style={styles.menuIntroCopy}>Finished rounds and practice sessions appear here. Use End round when you finish playing.</Text></View>}
            {pastSessions.map((session) => <View key={session.id} style={styles.courseItem}>
              <Pressable onPress={() => { setViewedSessionId(session.id); setExpandedHole(null); setShowingRoundSummary(false); setScreen('RoundDetail'); }} style={styles.courseItemSelect} accessibilityRole="button">
                <View style={styles.courseItemCopy}><Text style={styles.courseItemName}>{session.courseName}</Text><Text style={styles.courseItemMeta}>{formatSessionDate(session)} · {sessionSummary(session)}</Text></View>
                {session.mode === 'Practice' && <Text style={styles.sessionModeTag}>PRACTICE</Text>}
                <Text style={styles.menuArrow}>›</Text>
              </Pressable>
              <Pressable onPress={() => deleteRound(session)} style={styles.deleteButton} accessibilityRole="button" accessibilityLabel={`Delete ${session.courseName} ${session.mode === 'Round' ? 'round' : 'practice session'} from ${formatSessionDate(session)}`}><Text style={styles.deleteButtonText}>DELETE</Text></Pressable>
            </View>)}
          </ScrollView>
        ) : screen === 'RoundDetail' ? (
          <ScrollView ref={roundDetailScrollRef} contentContainerStyle={styles.content}>
            {!viewedSession ? <Text style={styles.mapInstruction}>This round is no longer available.</Text> : <>
              <View style={styles.finalScore}>
                <Text style={styles.menuIntroLabel}>FINAL SCORE</Text>
                <View style={styles.finalScoreRow}>
                  <Text style={styles.finalScoreValue}>{viewedScore?.strokes ?? viewedSession.shots.length}</Text>
                  {viewedScore?.toPar != null && <Text style={[styles.finalScoreToPar, viewedScore.toPar < 0 && styles.underPar, viewedScore.toPar > 0 && styles.overPar]}>{formatScoreToPar(viewedScore.toPar)}</Text>}
                </View>
                <Text style={styles.menuIntroCopy}>{[
                  `${viewedHoles.length} ${viewedHoles.length === 1 ? 'hole' : 'holes'}`,
                  viewedLayoutLabel ? `${viewedLayoutLabel} layout` : null,
                  viewedScore?.holesWithPar ? `Par ${viewedPar}` : null,
                  `${viewedSession.shots.reduce((sum, shot) => sum + shot.feet, 0).toLocaleString()} ft thrown`,
                ].filter(Boolean).join(' · ')}</Text>
                {viewedResults.length > 0 && <View style={styles.resultChips}>{viewedResults.map((result) => <View key={result.label} style={styles.resultChip}><Text style={styles.resultChipText}>{result.count} {result.label}{result.count === 1 || result.label.endsWith('+') || result.label.endsWith('better') ? '' : 's'}</Text></View>)}</View>}
              </View>
              <Pressable onPress={() => resumeSession(viewedSession)} style={[styles.addHoleButton, styles.resumeButton]} accessibilityRole="button"><Text style={styles.addHoleButtonText}>RESUME {viewedSession.mode === 'Round' ? 'ROUND' : 'SESSION'} ▶</Text></Pressable>
              <View style={styles.toggleRow}>
                <View style={styles.toggleCopy}>
                  <Text style={styles.courseItemName}>Share this {viewedSession.mode === 'Round' ? 'round' : 'session'}</Text>
                  <Text style={styles.courseItemMeta}>{!account ? 'Sign in to share a link to this scorecard.' : viewedSession.shared ? (viewedSession.shareToken ? 'Anyone with the link can see this scorecard and the course it was played on.' : 'Creating link on next sync…') : 'Only you can see this round.'}</Text>
                </View>
                {account
                  ? <Switch value={Boolean(viewedSession.shared)} onValueChange={(shared) => setRoundShared(viewedSession.id, shared)} trackColor={{ true: GREEN }} accessibilityLabel="Share this round" />
                  : <Pressable onPress={() => setScreen('Account')} style={styles.courseLink}><Text style={styles.courseLinkText}>SIGN IN</Text></Pressable>}
              </View>
              {account && viewedSession.shared && viewedSession.shareToken ? <Pressable onPress={() => shareLink(`My round at ${viewedSession.courseName}:`, roundShareUrl(viewedSession.shareToken!))} style={[styles.courseLink, styles.toggleAction]}><Text style={styles.courseLinkText}>SEND LINK</Text></Pressable> : null}
              <Text style={styles.sectionTitle}>Scorecard</Text>
              <View style={styles.scorecard}>
                <View style={[styles.scorecardRow, styles.scorecardHeader]}><Text style={[styles.scorecardCell, styles.scorecardHoleCell, styles.scorecardHeaderText]}>HOLE</Text><Text style={[styles.scorecardCell, styles.scorecardHeaderText]}>PAR</Text><Text style={[styles.scorecardCell, styles.scorecardHeaderText]}>SCORE</Text><Text style={[styles.scorecardCell, styles.scorecardHeaderText]}>+/−</Text></View>
                {viewedHoles.map((item) => {
                  const diff = item.par === undefined ? null : countStrokes(item.shots) - item.par;
                  return <Pressable key={item.hole} onPress={() => toggleRoundHoleMap(item.hole, true)} style={[styles.scorecardRow, expandedHole === item.hole && styles.scorecardRowActive]} accessibilityRole="button" accessibilityLabel={`Show map for hole ${item.hole}`}>
                    <Text style={[styles.scorecardCell, styles.scorecardHoleCell]}>{String(item.hole).padStart(2, '0')}</Text>
                    <Text style={styles.scorecardCell}>{item.par ?? '—'}</Text>
                    <Text style={[styles.scorecardCell, styles.scorecardScore]}>{countStrokes(item.shots)}</Text>
                    <Text style={[styles.scorecardCell, diff !== null && diff < 0 && styles.underPar, diff !== null && diff > 0 && styles.overPar]}>{diff === null ? '—' : formatScoreToPar(diff)}</Text>
                  </Pressable>;
                })}
                <View style={[styles.scorecardRow, styles.scorecardTotal]}>
                  <Text style={[styles.scorecardCell, styles.scorecardHoleCell, styles.scorecardHeaderText]}>TOTAL</Text>
                  <Text style={styles.scorecardCell}>{viewedScore?.holesWithPar ? viewedPar : '—'}</Text>
                  <Text style={[styles.scorecardCell, styles.scorecardScore]}>{viewedScore?.strokes ?? viewedSession.shots.length}</Text>
                  <Text style={[styles.scorecardCell, viewedScore?.toPar != null && viewedScore.toPar < 0 && styles.underPar, viewedScore?.toPar != null && viewedScore.toPar > 0 && styles.overPar]}>{viewedScore?.toPar == null ? '—' : formatScoreToPar(viewedScore.toPar)}</Text>
                </View>
              </View>
              {viewedScore && viewedScore.holesWithPar < viewedScore.holesCompleted && <Text style={styles.mapInstruction}>{viewedScore.holesWithPar ? `To par counts only the ${viewedScore.holesWithPar} holes with a par set.` : 'Set pars for this course in Course builder to see your score to par.'}</Text>}
              {viewedSession.mode === 'Practice' && <Text style={styles.mapInstruction}>Practice session</Text>}
              <StatsSummary title="Round summary" rounds={[{ shots: viewedSession.shots, layouts: viewedCourse?.layouts ?? [] }]} scope="this round" />
              <Text style={[styles.sectionTitle, styles.throwByThrowTitle]}>Throw by throw</Text>
              <Text style={styles.mapInstruction}>Tap a hole to see where each throw was logged, or a throw to edit or delete it.</Text>
              {viewedHoles.map((item) => <View key={item.hole} style={styles.roundHole} onLayout={(event) => { holeSectionOffsets.current[item.hole] = event.nativeEvent.layout.y; }}>
                <Pressable onPress={() => toggleRoundHoleMap(item.hole)} style={styles.roundHoleHeader} accessibilityRole="button" accessibilityState={{ expanded: expandedHole === item.hole }}>
                  <Text style={styles.roundHoleTitle}>Hole {String(item.hole).padStart(2, '0')} <Text style={styles.roundHoleMapToggle}>{expandedHole === item.hole ? '− MAP' : '+ MAP'}</Text></Text>
                  <Text style={styles.roundHoleMeta}>{item.par !== undefined ? `PAR ${item.par} · ` : ''}{countStrokes(item.shots)} {countStrokes(item.shots) === 1 ? 'STROKE' : 'STROKES'}{item.par !== undefined ? ` (${formatScoreToPar(countStrokes(item.shots) - item.par)})` : ''}</Text>
                </Pressable>
                {expandedHole === item.hole && renderRoundHoleMap(item.hole, item.shots)}
                {item.shots.map((shot, index) => <Pressable key={index} onPress={() => openThrowEditor(viewedSession, shot)} style={styles.throwRow} accessibilityRole="button" accessibilityLabel={`Edit throw ${index + 1} on hole ${item.hole}`}>
                  <Text style={[styles.roundThrow, styles.throwRowText]}>{index + 1}.  {formatThrowDetail(shot)}</Text>
                  <Text style={styles.throwEditHint}>EDIT</Text>
                </Pressable>)}
              </View>)}
              {showingRoundSummary && <Pressable onPress={() => setScreen('Home')} style={styles.finishButton}><Text style={styles.finishButtonText}>DONE</Text></Pressable>}
              <Pressable onPress={() => deleteRound(viewedSession)} style={styles.endSessionButton} accessibilityRole="button"><Text style={styles.endSessionText}>DELETE {viewedSession.mode === 'Round' ? 'ROUND' : 'SESSION'}</Text></Pressable>
            </>}
          </ScrollView>
        ) : screen === 'Insights' ? (
          <ScrollView contentContainerStyle={styles.content}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {[{ key: 'all', name: 'All courses', count: statsSessions.length }, ...statsCourses.map((group) => ({ key: group.key, name: group.name, count: group.sessions.length }))].map((option) => (
                <Pressable key={option.key} onPress={() => setStatsCourse(option.key)} style={[styles.chip, activeStatsCourse === option.key && styles.chipSelected]} accessibilityRole="button" accessibilityState={{ selected: activeStatsCourse === option.key }}>
                  <Text style={[styles.chipText, activeStatsCourse === option.key && styles.chipTextSelected]}>{option.name} ({option.count})</Text>
                </Pressable>))}
            </ScrollView>
            <View style={[styles.toggleRow, styles.statsToggle]}>
              <Text style={[styles.courseItemName, styles.toggleCopy]}>Include practice sessions</Text>
              <Switch value={statsPractice} onValueChange={setStatsPractice} trackColor={{ true: GREEN }} accessibilityLabel="Include practice sessions" />
            </View>
            {!statsSelected.length ? <Text style={styles.mapInstruction}>No finished {statsPractice ? 'sessions' : 'rounds'} yet. Stats include rounds once you end them.</Text> : <>
              {statsScores.length > 0 && <View style={styles.courseStatsGrid}>
                <StatTile label="ROUNDS" value={statsScores.length} note={statsSelected.length > statsScores.length ? `+ ${statsSelected.length - statsScores.length} practice` : null} />
                <StatTile label="AVG SCORE" value={averageOf(statsScores.map((item) => item.score.strokes)).toFixed(1)} note={activeStatsCourse === 'all' && statsCourses.length > 1 ? 'Across different courses' : null} />
                <StatTile label="AVG TO PAR" value={statsWithPar.length ? formatScoreToPar(Math.round(averageOf(statsWithPar.map((item) => item.score.toPar!)) * 10) / 10) : '—'} note={statsWithPar.length < statsScores.length ? `${statsWithPar.length} of ${statsScores.length} rounds have pars` : null} />
                <Pressable onPress={() => { if (!statsBest) return; setViewedSessionId(statsBest.session.id); setExpandedHole(null); setShowingRoundSummary(false); setScreen('RoundDetail'); }} style={styles.courseStat} accessibilityRole="button" accessibilityLabel="Open best round">
                  <Text style={styles.statLabel}>BEST ROUND</Text>
                  <Text style={styles.courseStatValue}>{statsBest ? formatScoreToPar(statsBest.score.toPar!) : '—'}</Text>
                  {statsBest && <Text style={styles.courseStatNote}>{statsBest.session.courseName} · {formatSessionDate(statsBest.session)} ›</Text>}
                </Pressable>
              </View>}
              {activeStatsCourse === 'all' && statsCourses.length > 1 && <>
                <Text style={styles.statsHeading}>By course</Text>
                {statsCourses.map((group) => {
                  const scores = group.sessions.filter((session) => session.mode === 'Round').map((session) => statsRoundScore(session.shots, sessionLayouts(session)));
                  const withPar = scores.filter((score) => score.toPar !== null);
                  return <Pressable key={group.key} onPress={() => setStatsCourse(group.key)} style={styles.courseItem} accessibilityRole="button">
                    <View style={styles.courseItemCopy}>
                      <Text style={styles.courseItemName}>{group.name}</Text>
                      <Text style={styles.courseItemMeta}>{[
                        `${group.sessions.length} ${group.sessions.length === 1 ? 'session' : 'sessions'}`,
                        scores.length ? `avg ${averageOf(scores.map((score) => score.strokes)).toFixed(1)}` : null,
                        withPar.length ? `avg ${formatScoreToPar(Math.round(averageOf(withPar.map((score) => score.toPar!)) * 10) / 10)}` : null,
                        withPar.length ? `best ${formatScoreToPar(Math.min(...withPar.map((score) => score.toPar!)))}` : null,
                      ].filter(Boolean).join(' · ')}</Text>
                    </View>
                    <Text style={styles.menuArrow}>›</Text>
                  </Pressable>;
                })}
              </>}
              <StatsSummary title="Throw stats" rounds={statsSelected.map((session) => ({ shots: session.shots, layouts: sessionLayouts(session) }))} scope="these rounds" />
            </>}
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.bagIntro}><Text style={styles.insightEyebrow}>ACTIVE SELECTION</Text><Text style={styles.bagHeadline}>{disc}</Text><Text style={styles.bagBody}>Choose a disc before your next throw. Your distance log will build a picture of each slot in your bag.</Text></View>
            {bag.map((item, index) => <Pressable key={`${item}-${index}`} onPress={() => setDisc(item)} style={[styles.bagItem, disc === item && styles.bagItemSelected]}><View style={[styles.discSwatch, { backgroundColor: ['#e08b48', '#619276', '#8ba4a0', '#d4d1c3'][index % 4] }]}><Text style={styles.discSwatchText}>{item.charAt(0).toUpperCase()}</Text></View><View style={styles.bagItemCopy}><Text style={styles.bagItemName}>{item}</Text><Text style={styles.bagItemMeta}>{shots.filter((shot) => shot.disc === item).length ? `${shots.filter((shot) => shot.disc === item).length} throws logged` : 'No throws logged yet'}</Text></View></Pressable>)}
          </ScrollView>
        )}

        <Modal visible={pendingLie !== null} transparent animationType="slide" onRequestClose={cancelLogThrow}>
          <View style={styles.sheetBackdrop}>
            <View style={styles.sheet}>
              <View style={styles.controlHeading}><Text style={styles.controlTitle}>Log throw {score + 1}</Text><Text style={styles.controlStep}>0{logStep} / 04</Text></View>
              <Text style={styles.sheetDistance}>{pendingLie?.feet ? `${pendingLie.feet} ft from ${activeShots.some((shot) => shot.latitude !== undefined) ? 'your previous lie' : 'the tee'}` : 'Distance unavailable: this hole’s tee is not mapped'}</Text>
              {logStep === 1 ? <>
                <Text style={styles.fieldLabel}>WHICH DISC?</Text>
                <View style={styles.sheetOptions}>
                  {bag.map((item, index) => <HoldPressable key={`${item}-${index}`} onPress={() => { setDisc(item); setLogStep(2); }} style={[styles.chip, styles.sheetChip, disc === item && styles.chipSelected]}><Text style={[styles.chipText, disc === item && styles.chipTextSelected]}>{item}</Text></HoldPressable>)}
                  {!bag.length && <HoldPressable onPress={() => { setDisc(''); setLogStep(2); }} style={[styles.chip, styles.sheetChip]}><Text style={styles.chipText}>No disc (bag is empty)</Text></HoldPressable>}
                </View>
              </> : logStep === 2 ? <>
                <Text style={styles.fieldLabel}>TYPE OF THROW</Text>
                <View style={styles.typeRow}>
                  {TYPE_OPTIONS.map((item) => <HoldPressable key={item} onPress={() => setThrowType(item)} style={[styles.typeButton, styles.sheetTypeButton, throwType === item && styles.typeButtonSelected]} accessibilityState={{ selected: throwType === item }}><Text style={[styles.typeText, throwType === item && styles.typeTextSelected]}>{item}</Text></HoldPressable>)}
                </View>
                <Text style={[styles.fieldLabel, styles.typeLabel]}>HOW DID YOU THROW IT?</Text>
                <View style={[styles.typeRow, styles.lieGrid]}>
                  {STYLE_OPTIONS.map((item) => <HoldPressable key={item} onPress={() => { setThrowStyle(item); setLogStep(3); }} style={[styles.typeButton, styles.sheetTypeButton, styles.styleButton, throwStyle === item && styles.typeButtonSelected]}><Text style={[styles.typeText, throwStyle === item && styles.typeTextSelected]}>{item}</Text></HoldPressable>)}
                </View>
              </> : logStep === 3 ? <>
                <Text style={styles.fieldLabel}>{throwType === 'Putt' ? 'PUTT RESULT' : 'WHERE DID IT LAND?'}</Text>
                <View style={[styles.typeRow, styles.lieGrid]}>
                  {lieOptionsFor(throwType).map((item) => <HoldPressable key={item} onPress={() => { if (item === 'Basket') { saveThrow(QUALITY_MAX, 'Basket'); return; } setThrowLie(item); setLogStep(4); }} style={[styles.typeButton, styles.sheetTypeButton, styles.lieButton, item === 'OB' && styles.obButton, throwLie === item && styles.typeButtonSelected]} accessibilityLabel={item === 'OB' ? 'Out of bounds, one penalty stroke' : lieLabel(item, throwType)}><Text style={[styles.typeText, item === 'OB' && styles.obText, throwLie === item && styles.typeTextSelected]}>{lieLabel(item, throwType)}</Text>{item === 'OB' && <Text style={styles.obPenaltyText}>+1 STROKE</Text>}</HoldPressable>)}
                </View>
              </> : <>
                <Text style={styles.fieldLabel}>HOW WAS THE THROW?</Text>
                <View style={styles.typeRow}>
                  {QUALITY_OPTIONS.map((option) => <HoldPressable key={option.value} onPress={() => saveThrow(option.value)} style={[styles.typeButton, styles.qualityButton]} accessibilityLabel={`Quality ${option.value}, ${option.label}`}><Text style={styles.qualityValue}>{option.value}</Text><Text style={styles.qualityLabel}>{option.label}</Text></HoldPressable>)}
                </View>
              </>}
              <View style={styles.editFooter}>
                {logStep > 1 ? <HoldPressable onPress={() => setLogStep(logStep === 4 ? 3 : logStep === 3 ? 2 : 1)} style={styles.sheetFooterButton}><Text style={styles.undoText}>‹ BACK</Text></HoldPressable> : <View />}
                <View style={styles.editFooterActions}>
                  <HoldPressable onPress={cancelLogThrow} style={styles.sheetFooterButton}><Text style={styles.undoText}>CANCEL</Text></HoldPressable>
                  {/* Saves with the choices so far: the guesses plus anything changed. */}
                  <HoldPressable onPress={() => saveThrow(null)} style={[styles.sheetFooterButton, styles.saveButton]} accessibilityLabel={`Save now: ${disc || 'no disc'} ${throwStyle.toLowerCase()} ${throwType.toLowerCase()}, ${throwLie.toLowerCase()}`}><Text style={styles.saveButtonText}>SAVE ✓</Text></HoldPressable>
                </View>
              </View>
            </View>
          </View>
        </Modal>

        <Modal visible={roundPickerOpen} transparent animationType="slide" onRequestClose={() => setRoundPickerOpen(false)}>
          <View style={styles.sheetBackdrop}>
            <View style={[styles.sheet, styles.pickerSheet]}>
              {(() => {
                const pickerCourse = courses.find((course) => course.id === roundPickerCourseId);
                return <>
                  <View style={styles.controlHeading}><Text style={styles.controlTitle}>{pickerCourse ? 'Which layout?' : 'Which course?'}</Text><Text style={styles.controlStep}>{pickerCourse ? '02 / 02' : '01 / 02'}</Text></View>
                  {pickerCourse && <Text style={styles.sheetDistance}>{pickerCourse.name}</Text>}
                  <ScrollView style={styles.pickerList}>
                    {pickerCourse
                      ? courseLayouts(pickerCourse).map((layout) => {
                        const current = pickerCourse.id === selectedCourseId && layout.id === selectedLayoutId;
                        return <Pressable key={layout.id} onPress={() => pickRoundLayout(pickerCourse, layout.id)} style={[styles.courseItem, current && styles.courseItemSelected]} accessibilityRole="button"><View style={styles.courseItemCopy}><Text style={styles.courseItemName}>{layoutDisplayName(layout)}</Text><Text style={styles.courseItemMeta}>{layout.holes} {layout.holes === 1 ? 'hole' : 'holes'}</Text></View><Text style={styles.courseSelectedMark}>{current ? '✓' : '›'}</Text></Pressable>;
                      })
                      : courses.map((course) => {
                        const layoutCount = courseLayouts(course).length;
                        const current = course.id === selectedCourseId;
                        return <Pressable key={course.id} onPress={() => pickRoundCourse(course)} style={[styles.courseItem, current && styles.courseItemSelected]} accessibilityRole="button"><View style={styles.courseItemCopy}><Text style={styles.courseItemName}>{course.name}</Text><Text style={styles.courseItemMeta}>{layoutCount > 1 ? `${layoutCount} layouts` : `${course.holes} ${course.holes === 1 ? 'hole' : 'holes'}`}</Text></View><Text style={styles.courseSelectedMark}>{current ? '✓' : '›'}</Text></Pressable>;
                      })}
                  </ScrollView>
                  <View style={styles.editFooter}>
                    {pickerCourse ? <Pressable onPress={() => setRoundPickerCourseId(null)} style={styles.sheetFooterButton}><Text style={styles.undoText}>‹ BACK</Text></Pressable> : <View />}
                    <Pressable onPress={() => setRoundPickerOpen(false)} style={styles.sheetFooterButton}><Text style={styles.undoText}>CANCEL</Text></Pressable>
                  </View>
                </>;
              })()}
            </View>
          </View>
        </Modal>

        <Modal visible={editingThrow !== null} transparent animationType="slide" onRequestClose={() => setEditingThrow(null)}>
          <View style={styles.sheetBackdrop}>
            <View style={styles.sheet}>
              <View style={styles.controlHeading}><Text style={styles.controlTitle}>Edit throw</Text><Text style={styles.controlStep}>{editingShot ? `HOLE ${String(editingShot.hole).padStart(2, '0')}` : ''}</Text></View>
              {editingShot && <Text style={styles.sheetDistance}>{editingShot.feet ? `${editingShot.feet} ft` : 'Distance unavailable'}</Text>}
              <Text style={styles.fieldLabel}>DISC</Text>
              <View style={styles.sheetOptions}>
                {editDiscOptions.map((item) => <RoundButton key={item} onPress={() => setThrowDraft((draft) => ({ ...draft, disc: item }))} style={[styles.chip, styles.sheetChip, throwDraft.disc === item && styles.chipSelected]}><Text style={[styles.chipText, throwDraft.disc === item && styles.chipTextSelected]}>{item}</Text></RoundButton>)}
                {!editDiscOptions.length && <Text style={styles.chipText}>No discs in your bag</Text>}
              </View>
              <Text style={[styles.fieldLabel, styles.typeLabel]}>TYPE OF THROW</Text>
              <View style={styles.typeRow}>
                {TYPE_OPTIONS.map((item) => <RoundButton key={item} onPress={() => setThrowDraft((draft) => ({ ...draft, type: item }))} style={[styles.typeButton, styles.sheetTypeButton, throwDraft.type === item && styles.typeButtonSelected]}><Text style={[styles.typeText, throwDraft.type === item && styles.typeTextSelected]}>{item}</Text></RoundButton>)}
              </View>
              <Text style={[styles.fieldLabel, styles.typeLabel]}>HOW WAS IT THROWN?</Text>
              <View style={[styles.typeRow, styles.lieGrid]}>
                {STYLE_OPTIONS.map((item) => <RoundButton key={item} onPress={() => setThrowDraft((draft) => ({ ...draft, style: item }))} style={[styles.typeButton, styles.sheetTypeButton, styles.styleButton, throwDraft.style === item && styles.typeButtonSelected]}><Text style={[styles.typeText, throwDraft.style === item && styles.typeTextSelected]}>{item}</Text></RoundButton>)}
              </View>
              <Text style={[styles.fieldLabel, styles.typeLabel]}>{throwDraft.type === 'Putt' ? 'PUTT RESULT' : 'WHERE DID IT LAND?'}</Text>
              <View style={[styles.typeRow, styles.lieGrid]}>
                {lieOptionsFor(throwDraft.type).map((item) => <RoundButton key={item} onPress={() => setThrowDraft((draft) => ({ ...draft, lie: item }))} style={[styles.typeButton, styles.sheetTypeButton, styles.lieButton, item === 'OB' && styles.obButton, throwDraft.lie === item && styles.typeButtonSelected]}><Text style={[styles.typeText, item === 'OB' && styles.obText, throwDraft.lie === item && styles.typeTextSelected]}>{lieLabel(item, throwDraft.type)}</Text>{item === 'OB' && <Text style={styles.obPenaltyText}>+1 STROKE</Text>}</RoundButton>)}
              </View>
              <Text style={[styles.fieldLabel, styles.typeLabel]}>QUALITY</Text>
              <View style={styles.typeRow}>
                {QUALITY_OPTIONS.map((option) => <RoundButton key={option.value} onPress={() => setThrowDraft((draft) => ({ ...draft, quality: option.value }))} style={[styles.typeButton, styles.qualityButton, throwDraft.quality === option.value && styles.typeButtonSelected]} accessibilityLabel={`Quality ${option.value}, ${option.label}`}><Text style={styles.qualityValue}>{option.value}</Text><Text style={styles.qualityLabel}>{option.label}</Text></RoundButton>)}
              </View>
              <View style={styles.editFooter}>
                <RoundButton onPress={deleteEditingThrow} style={styles.sheetFooterButton}><Text style={styles.endSessionText}>DELETE</Text></RoundButton>
                <View style={styles.editFooterActions}>
                  <RoundButton onPress={() => setEditingThrow(null)} style={styles.sheetFooterButton}><Text style={styles.undoText}>CANCEL</Text></RoundButton>
                  <RoundButton onPress={saveThrowEdit} style={[styles.sheetFooterButton, styles.saveButton]}><Text style={styles.saveButtonText}>SAVE</Text></RoundButton>
                </View>
              </View>
            </View>
          </View>
        </Modal>

        {screen === 'Round' || screen === 'Insights' ? <View style={styles.bottomBar}><Text style={styles.bottomStatus}><View style={styles.statusDot} /> SESSION SAVED LOCALLY</Text><Text style={styles.bottomCount}>{shots.length} THROWS</Text></View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000000', alignItems: 'center' },
  appFrame: { flex: 1, width: '100%', maxWidth: 560, backgroundColor: PAPER, paddingTop: 48 },
  appFrameCompact: { paddingTop: 38 },
  topline: { height: 46, marginHorizontal: 23, flexDirection: 'row', alignItems: 'center' },
  brandLogo: { width: 34, height: 34, borderRadius: 8 },
  brand: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  brandCopy: { marginLeft: 10, flex: 1 },
  brandName: { color: INK, fontSize: 12, fontWeight: '800', letterSpacing: 1.25 },
  brandSub: { color: MUTED, fontSize: 8, fontWeight: '700', marginTop: 3 },
  avatar: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: '#26302b', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: INK, fontSize: 10, fontWeight: '800' },
  avatarSignedIn: { backgroundColor: GREEN, borderColor: GREEN },
  avatarTextSignedIn: { color: '#e6ece8' },
  weightField: { flexDirection: 'row', alignItems: 'center', marginLeft: 6 },
  weightInput: { width: 48, height: 34, borderWidth: 1, borderColor: '#26302b', borderRadius: 6, textAlign: 'center', color: INK, fontSize: 13, fontVariant: ['tabular-nums'], backgroundColor: '#101412' },
  weightUnit: { color: MUTED, fontSize: 10, fontWeight: '700', marginLeft: 4 },
  latestCopy: { flex: 1, paddingVertical: 6, marginRight: 8 },
  newCourseButton: { marginTop: 0 },
  layoutMapCopy: { paddingVertical: 10 },
  stepDots: { flexDirection: 'row', marginBottom: 16 },
  stepDot: { flex: 1, alignItems: 'center' },
  stepDotMark: { width: '90%', height: 4, borderRadius: 2, backgroundColor: '#26302b' },
  stepDotMarkDone: { backgroundColor: GREEN },
  stepDotLabel: { color: MUTED, fontSize: 7, fontWeight: '800', letterSpacing: 0.6, marginTop: 5 },
  stepDotLabelCurrent: { color: INK },
  statsSection: { marginTop: 8, marginBottom: 18 },
  statsHeading: { color: INK, fontFamily: 'Georgia', fontSize: 15, marginTop: 14, marginBottom: 6 },
  statsChips: { color: MUTED, fontSize: 11, lineHeight: 17 },
  statsToggle: { marginTop: 4 },
  statTable: { borderRadius: 8, borderWidth: 1, borderColor: '#26302b', overflow: 'hidden', marginBottom: 4 },
  statTableRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: '#1b2420' },
  statTableHead: { backgroundColor: '#141816', borderTopWidth: 0 },
  statHeadText: { color: MUTED, fontSize: 7, fontWeight: '800', letterSpacing: 0.6 },
  statCellName: { flex: 1.6, color: INK, fontSize: 11, fontWeight: '700' },
  statCell: { flex: 1, color: INK, fontSize: 11, textAlign: 'right', fontVariant: ['tabular-nums'] },
  caddieRow: { borderTopWidth: 1, borderTopColor: '#26302b', marginTop: 6, paddingTop: 6 },
  caddieText: { color: INK, fontSize: 13, fontWeight: '700', marginTop: 3 },
  caddieMeta: { color: MUTED, fontSize: 11, fontWeight: '400' },
  authIntro: { color: MUTED, fontSize: 11, lineHeight: 16, marginBottom: 8 },
  authNotice: { color: GREEN, fontSize: 11, lineHeight: 16, marginBottom: 8 },
  codeInput: { fontSize: 20, letterSpacing: 6, fontVariant: ['tabular-nums'] },
  textLink: { alignSelf: 'center', paddingVertical: 10, marginTop: 4 },
  textLinkText: { color: GREEN, fontSize: 12, fontWeight: '700' },
  resumeButton: { marginTop: 0, marginBottom: 12 },
  throwRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3 },
  throwRowText: { flex: 1 },
  throwEditHint: { color: GREEN, fontSize: 7, fontWeight: '800', letterSpacing: 0.6, marginLeft: 8 },
  editFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 18 },
  editFooterActions: { flexDirection: 'row' },
  saveButton: { backgroundColor: GREEN, borderColor: GREEN, marginLeft: 8 },
  saveButtonText: { color: '#e6ece8', fontSize: 8, fontWeight: '800' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, marginBottom: 10, padding: 12, borderRadius: 8, backgroundColor: '#101412', borderWidth: 1, borderColor: '#26302b' },
  toggleCopy: { flex: 1, marginRight: 12 },
  toggleAction: { alignSelf: 'flex-start', marginTop: 0, marginBottom: 16 },
  authTabs: { marginTop: 0, marginBottom: 12 },
  authError: { color: '#d07a68', fontSize: 10, lineHeight: 15, marginTop: 10 },
  accountStatus: { color: INK, fontFamily: 'Georgia', fontSize: 17, marginTop: 6, marginBottom: 4 },
  serverNote: { color: '#6b766f', fontSize: 7, fontWeight: '700', letterSpacing: 0.6, marginTop: 24, textAlign: 'center' },
  backLink: { alignSelf: 'flex-start', paddingVertical: 6, marginBottom: 8 },
  pageHeadingCompact: { marginTop: 4, marginBottom: 0, justifyContent: 'flex-end' },
  pageHeading: { marginHorizontal: 23, marginTop: 28, marginBottom: 19, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  eyebrow: { color: GREEN, fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: INK, fontFamily: 'Georgia', fontSize: 30, marginTop: 5 },
  weather: { flexDirection: 'row', alignItems: 'center', marginBottom: 5 },
  weatherIcon: { fontSize: 14, color: '#d38244', marginRight: 4 },
  weatherText: { color: MUTED, fontSize: 8, fontWeight: '800' },
  homeButton: { borderWidth: 1, borderColor: '#26302b', paddingHorizontal: 11, paddingVertical: 8, borderRadius: 6 },
  homeButtonText: { color: GREEN, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  content: { paddingHorizontal: 23, paddingTop: 15, paddingBottom: 20 },
  menuIntro: { backgroundColor: '#0f1a14', borderRadius: 9, padding: 18, marginTop: 1, marginBottom: 17 },
  menuIntroLabel: { color: GREEN, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  menuIntroTitle: { color: INK, fontFamily: 'Georgia', fontSize: 21, marginTop: 8 },
  menuIntroCopy: { color: MUTED, fontSize: 10, marginTop: 5 },
  menuOptions: { borderTopWidth: 1, borderTopColor: '#26302b' },
  menuItem: { minHeight: 76, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#26302b', paddingHorizontal: 5 },
  resumeItem: { marginTop: 0, marginBottom: 14 },
  menuItemPrimary: { backgroundColor: GREEN, borderBottomColor: GREEN, paddingHorizontal: 12, marginTop: 9, borderRadius: 7 },
  menuNumber: { color: '#6b766f', fontSize: 10, fontWeight: '800', width: 37 },
  menuNumberPrimary: { color: '#bcd2c0' },
  menuItemCopy: { flex: 1 },
  menuTitle: { color: INK, fontFamily: 'Georgia', fontSize: 17 },
  menuTitlePrimary: { color: '#e6ece8' },
  menuSubtitle: { color: MUTED, fontSize: 9, marginTop: 4 },
  menuSubtitlePrimary: { color: '#d2e1d5' },
  menuArrow: { color: GREEN, fontSize: 24, paddingHorizontal: 8 },
  menuArrowPrimary: { color: '#e6ece8' },
  builderPanel: { backgroundColor: '#101412', padding: 16, borderRadius: 8, borderWidth: 1, borderColor: '#26302b', marginBottom: 24 },
  builderLabel: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
  detailLabel: { marginTop: 14 },
  cityStateRow: { flexDirection: 'row' },
  courseStatsGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4, marginBottom: 14 },
  courseStat: { width: '50%', paddingVertical: 10, paddingRight: 10 },
  courseStatValue: { color: INK, fontFamily: 'Georgia', fontSize: 21, marginTop: 4 },
  courseStatNote: { color: MUTED, fontSize: 8, marginTop: 3 },
  roundCourseInfo: { marginTop: 18, padding: 14, borderRadius: 9, backgroundColor: '#101412', borderWidth: 1, borderColor: '#26302b' },
  roundCourseInfoHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  roundCourseInfoText: { color: INK, fontSize: 11, marginTop: 6 },
  roundCourseNotesLabel: { marginTop: 12 },
  roundCourseNotes: { color: INK, fontSize: 11, lineHeight: 17, marginTop: 5 },
  cityField: { flex: 1, marginRight: 12 },
  stateField: { width: 64 },
  notesInput: { height: 96, paddingTop: 10 },
  courseLinks: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 14 },
  courseLink: { height: 34, paddingHorizontal: 12, marginRight: 8, marginBottom: 8, borderRadius: 6, borderWidth: 1, borderColor: GREEN, alignItems: 'center', justifyContent: 'center' },
  courseLinkText: { color: GREEN, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  builderInput: { height: 43, borderBottomWidth: 1, borderBottomColor: '#26302b', color: INK, fontSize: 13, paddingHorizontal: 2, marginTop: 5 },
  primaryButton: { minHeight: 46, borderRadius: 7, backgroundColor: GREEN, alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  disabledButton: { opacity: 0.5 },
  primaryButtonText: { color: '#e6ece8', fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  builderSectionTitle: { color: INK, fontFamily: 'Georgia', fontSize: 18, marginBottom: 7 },
  courseItem: { minHeight: 62, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#26302b', paddingHorizontal: 7 },
  courseItemSelected: { backgroundColor: '#16231c' },
  courseItemSelect: { flex: 1, minHeight: 61, flexDirection: 'row', alignItems: 'center' },
  courseItemCopy: { flex: 1 },
  courseItemName: { color: INK, fontSize: 12, fontWeight: '700' },
  courseItemMeta: { color: MUTED, fontSize: 9, marginTop: 4 },
  courseSelectedMark: { color: GREEN, fontSize: 16, paddingHorizontal: 8 },
  deleteButton: { minHeight: 36, minWidth: 54, alignItems: 'center', justifyContent: 'center', marginLeft: 6 },
  deleteButtonText: { color: '#d07a68', fontSize: 8, fontWeight: '800', letterSpacing: 0.4 },
  deleteHoleButton: { minHeight: 34, alignSelf: 'flex-end', justifyContent: 'center', paddingHorizontal: 8, marginTop: 6 },
  mapEditor: { marginTop: 24, paddingTop: 18, borderTopWidth: 1, borderTopColor: '#26302b' },
  mapEditorHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  mapProgress: { color: GREEN, fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },
  editorHoleNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  holeNavButton: { width: 38, height: 36, borderWidth: 1, borderColor: '#26302b', borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  holeNavDisabled: { opacity: 0.35 },
  holeNavArrow: { color: GREEN, fontSize: 22, lineHeight: 25 },
  editorHoleCopy: { alignItems: 'center' },
  editorHoleName: { color: INK, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  editorHoleStatus: { color: MUTED, fontSize: 8, marginTop: 4 },
  markerTargetRow: { flexDirection: 'row', marginTop: 13, backgroundColor: '#151917', borderRadius: 7, padding: 3 },
  markerTarget: { flex: 1, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 5 },
  markerTargetActive: { backgroundColor: '#101412' },
  markerTargetText: { color: MUTED, fontSize: 9, fontWeight: '700' },
  markerTargetTextActive: { color: GREEN, fontWeight: '800' },
  mapInstruction: { color: MUTED, fontSize: 9, marginTop: 10 },
  gpsPointCard: { padding: 12, marginTop: 9, borderWidth: 1, borderColor: '#26302b', borderRadius: 7, backgroundColor: '#101412' },
  gpsPointHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  gpsPointLabel: { color: INK, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  gpsPointState: { color: '#d39a6e', fontSize: 7, fontWeight: '800', letterSpacing: 0.4 },
  gpsPointSaved: { color: GREEN },
  gpsCoordinates: { color: INK, fontSize: 12, fontVariant: ['tabular-nums'], marginTop: 7 },
  gpsAccuracy: { color: MUTED, fontSize: 8, marginTop: 4 },
  holeDistance: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 10, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 7, backgroundColor: '#0f1a14' },
  parPicker: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  parOptions: { flexDirection: 'row' },
  parOption: { width: 40, height: 36, marginLeft: 6, borderRadius: 6, borderWidth: 1, borderColor: '#26302b', alignItems: 'center', justifyContent: 'center' },
  parOptionSelected: { backgroundColor: GREEN, borderColor: GREEN },
  parOptionText: { color: INK, fontFamily: 'Georgia', fontSize: 16 },
  parOptionTextSelected: { color: '#e6ece8' },
  holeDistanceLabel: { color: GREEN, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  holeDistanceValue: { color: INK, fontFamily: 'Georgia', fontSize: 20, fontVariant: ['tabular-nums'] },
  gpsMessage: { color: GREEN, fontSize: 9, lineHeight: 14, marginTop: 10 },
  holeWizard: { flex: 1, paddingHorizontal: 23, paddingBottom: 14 },
  wizardProgress: { height: 38, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  wizardMappedCount: { marginTop: 4 },
  satelliteFrame: { flex: 1, minHeight: 230, marginTop: 6, borderRadius: 8, overflow: 'hidden', backgroundColor: '#0d1410', position: 'relative' },
  satelliteMap: { ...StyleSheet.absoluteFill },
  satelliteBadge: { position: 'absolute', top: 11, left: 11, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 5, backgroundColor: 'rgba(24,35,31,0.82)' },
  satelliteBadgeText: { color: '#e6ece8', fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  recenterButton: { position: 'absolute', top: 10, right: 10, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 5, backgroundColor: '#101412' },
  recenterButtonText: { color: INK, fontSize: 8, fontWeight: '800' },
  mapScaleBadge: { position: 'absolute', left: 11, bottom: 11, minWidth: 120, paddingHorizontal: 9, paddingVertical: 8, borderRadius: 5, backgroundColor: 'rgba(0,0,0,0.75)' },
  mapScaleRule: { height: 4, maxWidth: '100%', borderBottomWidth: 2, borderLeftWidth: 1, borderRightWidth: 1, borderColor: INK, marginBottom: 4 },
  mapScaleLabel: { color: INK, fontSize: 8, fontWeight: '800' },
  mapScaleWidth: { color: MUTED, fontSize: 7, fontWeight: '700', marginTop: 2 },
  mapUnavailable: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#0f1a14' },
  mapUnavailableTitle: { color: INK, fontFamily: 'Georgia', fontSize: 17, textAlign: 'center' },
  mapUnavailableText: { color: MUTED, fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: 8 },
  captureButtons: { flexDirection: 'row', marginTop: 10 },
  captureButton: { flex: 1, minHeight: 78, paddingHorizontal: 9, paddingVertical: 10, borderRadius: 7, borderWidth: 1, borderColor: '#26302b', backgroundColor: '#101412', marginRight: 8 },
  captureButtonSaved: { borderColor: GREEN, backgroundColor: '#16231c' },
  captureButtonLabel: { color: INK, fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  captureButtonValue: { color: GREEN, fontSize: 8, fontWeight: '800', marginTop: 5 },
  captureButtonCoords: { color: MUTED, fontSize: 8, marginTop: 5, fontVariant: ['tabular-nums'] },
  wizardNavigation: { flexDirection: 'row', marginTop: 9 },
  wizardNavButton: { flex: 1, minHeight: 42, borderWidth: 1, borderColor: '#26302b', borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginRight: 7 },
  wizardNavNext: { backgroundColor: GREEN, borderColor: GREEN, marginRight: 0, marginLeft: 7 },
  wizardNavText: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.4 },
  wizardNavNextText: { color: '#e6ece8' },
  wizardNavFinish: { marginRight: 0, borderColor: GREEN },
  wizardNavFinishText: { color: GREEN, fontSize: 8, fontWeight: '800', letterSpacing: 0.4 },
  builderHint: { color: MUTED, fontSize: 9, marginTop: 8 },
  parEditorHeading: { marginTop: 22 },
  parRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#26302b' },
  parStepButton: { width: 36, height: 36, borderRadius: 6, borderWidth: 1, borderColor: '#26302b', alignItems: 'center', justifyContent: 'center' },
  parStepText: { color: GREEN, fontSize: 18, fontWeight: '600' },
  parStepValue: { width: 38, textAlign: 'center', color: INK, fontFamily: 'Georgia', fontSize: 18 },
  addHoleButton: { height: 42, marginTop: 12, borderRadius: 6, borderWidth: 1, borderColor: GREEN, alignItems: 'center', justifyContent: 'center' },
  addHoleButtonText: { color: GREEN, fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  secondaryStart: { marginTop: 19, minHeight: 44, borderWidth: 1, borderColor: GREEN, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  secondaryStartText: { color: GREEN, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  builderFootnote: { color: '#6b766f', fontSize: 9, lineHeight: 14, marginTop: 11 },
  addDiscRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  discInput: { flex: 1, marginRight: 12 },
  discResults: { marginTop: 10, borderTopWidth: 1, borderTopColor: '#26302b' },
  discResult: { minHeight: 52, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#26302b' },
  discResultCopy: { flex: 1, marginRight: 8 },
  discResultFlight: { color: INK, fontSize: 10, fontWeight: '700', fontVariant: ['tabular-nums'] },
  discResultsNote: { color: MUTED, fontSize: 10, lineHeight: 15, paddingVertical: 10 },
  discResultsCredit: { color: MUTED, fontSize: 7, fontWeight: '700', letterSpacing: 0.5, marginTop: 8 },
  addDiscButton: { height: 34, minWidth: 56, paddingHorizontal: 13, backgroundColor: GREEN, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  addDiscButtonText: { color: '#e6ece8', fontSize: 9, fontWeight: '800' },
  practiceIntro: { backgroundColor: '#0f1a14', borderRadius: 9, padding: 18, marginBottom: 17 },
  practiceIntroTitle: { color: INK, fontFamily: 'Georgia', fontSize: 20, marginTop: 9 },
  practiceIntroCopy: { color: MUTED, fontSize: 10, lineHeight: 15, marginTop: 6 },
  practiceChoice: { minHeight: 67, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#26302b', paddingHorizontal: 8 },
  practiceChoiceSelected: { backgroundColor: '#16231c' },
  practiceChoiceCopy: { flex: 1 },
  practiceChoiceTitle: { color: INK, fontFamily: 'Georgia', fontSize: 16 },
  practiceChoiceSubtitle: { color: MUTED, fontSize: 9, marginTop: 4 },
  practiceChoiceMark: { color: GREEN, fontSize: 16, paddingHorizontal: 9 },
  courseLabel: { flex: 1, paddingRight: 10 },
  courseLabelName: { color: INK, fontSize: 12, fontWeight: '700', marginTop: 4 },
  roundToolbar: { height: 45, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modeSwitch: { flexDirection: 'row', backgroundColor: '#151917', borderRadius: 8, padding: 3 },
  modeOption: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 6 },
  modeSelected: { backgroundColor: '#101412' },
  modeText: { color: MUTED, fontSize: 10, fontWeight: '700' },
  modeTextSelected: { color: INK },
  holeSelector: { alignItems: 'center' },
  roundHoleNav: { flexDirection: 'row', alignItems: 'center' },
  roundHoleArrow: { width: 34, height: 40, borderWidth: 1, borderColor: '#26302b', borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginHorizontal: 8 },
  holeLabel: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  holeNumber: { color: INK, fontFamily: 'Georgia', fontSize: 20 },
  holeTotal: { color: MUTED, fontFamily: 'Arial', fontSize: 11 },
  chevron: { color: GREEN, fontFamily: 'Arial', fontSize: 12 },
  sectionTitle: { color: INK, fontFamily: 'Georgia', fontSize: 18 },
  scoreStrip: { flexDirection: 'row', backgroundColor: '#0f1a14', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 4, marginTop: 6, marginBottom: 10 },
  scoreStripItem: { flex: 1, alignItems: 'center' },
  scoreStripLabel: { color: MUTED, fontSize: 7, fontWeight: '800', letterSpacing: 0.6 },
  scoreStripValue: { color: INK, fontFamily: 'Georgia', fontSize: 16, marginTop: 2, fontVariant: ['tabular-nums'] },
  roundMapFrame: { height: 300, marginTop: 0, marginBottom: 17, borderRadius: 9, overflow: 'hidden', backgroundColor: '#0d1410', position: 'relative' },
  shotMarker: { width: 22, height: 22, borderRadius: 12, borderWidth: 2, borderColor: '#fff', backgroundColor: '#b8622c', alignItems: 'center', justifyContent: 'center' },
  shotPinText: { color: '#e6ece8', fontSize: 9, fontWeight: '900' },
  boardCaption: { position: 'absolute', bottom: 11, left: 12, right: 12, flexDirection: 'row', justifyContent: 'space-between' },
  boardCaptionText: { color: '#7d8981', fontSize: 7, fontWeight: '800', letterSpacing: 0.7 },
  boardScale: { color: '#6b766f', fontSize: 7, fontWeight: '700' },
  basketDistances: { flexDirection: 'column', alignItems: 'stretch' },
  basketDistanceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 2 },
  roundHoleDistance: { marginTop: -5, marginBottom: 15 },
  logThrowButton: { minHeight: 64, backgroundColor: '#b8622c', borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingVertical: 10 },
  logThrowButtonText: { color: '#e6ece8', fontSize: 13, fontWeight: '900', letterSpacing: 1.2 },
  logThrowButtonHint: { color: '#f3dccb', fontSize: 9, marginTop: 4 },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.65)' },
  sheet: { backgroundColor: PAPER, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, paddingBottom: 34, width: '100%', maxWidth: 560, alignSelf: 'center' },
  sheetDistance: { color: GREEN, fontSize: 11, fontWeight: '700', marginTop: -4, marginBottom: 16 },
  sheetOptions: { flexDirection: 'row', flexWrap: 'wrap', paddingTop: 9 },
  sheetChip: { height: 40, marginBottom: 8, paddingHorizontal: 14 },
  sheetTypeButton: { height: 46 },
  lieGrid: { flexWrap: 'wrap', marginRight: -7 },
  // Four per row.
  styleButton: { flex: 0, width: '22.5%', marginBottom: 7, paddingHorizontal: 2 },
  lieButton: { flex: 0, width: '31%', marginBottom: 7 },
  obButton: { borderColor: '#6e3b31' },
  obText: { color: '#d07a68' },
  obPenaltyText: { color: '#d07a68', fontSize: 7, fontWeight: '800', marginTop: 2 },
  qualityButton: { height: 58 },
  qualityValue: { color: INK, fontFamily: 'Georgia', fontSize: 19 },
  qualityLabel: { color: MUTED, fontSize: 8, fontWeight: '700', marginTop: 2 },
  sheetFooter: { flexDirection: 'row-reverse', justifyContent: 'space-between', marginTop: 18 },
  pickerSheet: { maxHeight: '80%' },
  pickerList: { flexGrow: 0 },
  sheetFooterButton: { borderWidth: 1, borderColor: '#26302b', borderRadius: 5, paddingHorizontal: 14, paddingVertical: 10 },
  controlHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  controlTitle: { color: INK, fontFamily: 'Georgia', fontSize: 17 },
  controlStep: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
  fieldLabel: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.9 },
  chipRow: { flexDirection: 'row', paddingTop: 7, paddingBottom: 2 },
  chip: { paddingHorizontal: 12, height: 30, borderRadius: 6, borderWidth: 1, borderColor: '#26302b', marginRight: 7, justifyContent: 'center' },
  chipSelected: { backgroundColor: GREEN, borderColor: GREEN },
  chipText: { color: '#a9b4ad', fontSize: 10, fontWeight: '700' },
  chipTextSelected: { color: '#e6ece8' },
  typeLabel: { marginTop: 9 },
  typeRow: { flexDirection: 'row', marginTop: 7 },
  typeButton: { flex: 1, height: 31, borderRadius: 6, borderWidth: 1, borderColor: '#26302b', alignItems: 'center', justifyContent: 'center', marginRight: 7 },
  typeButtonSelected: { backgroundColor: '#2a1d12', borderColor: '#7a5634' },
  typeText: { color: '#a9b4ad', fontSize: 10, fontWeight: '700' },
  typeTextSelected: { color: '#e0a070' },
  latestRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#26302b' },
  latestEyebrow: { color: MUTED, fontSize: 7, fontWeight: '800', letterSpacing: 0.8 },
  latestText: { color: INK, fontSize: 11, fontWeight: '600', marginTop: 4 },
  undoButton: { borderWidth: 1, borderColor: '#26302b', borderRadius: 5, paddingHorizontal: 10, paddingVertical: 7 },
  undoText: { color: MUTED, fontSize: 8, fontWeight: '800' },
  finishButton: { height: 46, backgroundColor: GREEN, borderRadius: 7, marginTop: 12, alignItems: 'center', justifyContent: 'center' },
  endSessionButton: { height: 42, borderRadius: 7, borderWidth: 1, borderColor: '#26302b', marginTop: 8, alignItems: 'center', justifyContent: 'center' },
  endSessionText: { color: '#d07a68', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  finishButtonText: { color: '#e6ece8', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  finishArrow: { fontSize: 14 },
  footnote: { textAlign: 'center', color: '#6b766f', fontSize: 8, marginTop: 10, marginBottom: 2 },
  bottomBar: { height: 36, borderTopWidth: 1, borderTopColor: '#26302b', paddingHorizontal: 23, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bottomStatus: { color: MUTED, fontSize: 7, fontWeight: '800', letterSpacing: 0.7 },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#6f9a68', marginRight: 5 },
  bottomCount: { color: MUTED, fontSize: 7, fontWeight: '800' },
  insightHero: { marginTop: 6, padding: 20, backgroundColor: '#0f1a14', borderRadius: 9 },
  insightEyebrow: { color: GREEN, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  insightNumber: { color: INK, fontFamily: 'Georgia', fontSize: 48, marginTop: 10 },
  insightUnit: { color: MUTED, fontFamily: 'Arial', fontSize: 16 },
  insightCaption: { color: MUTED, fontSize: 9, fontWeight: '600' },
  sparkline: { height: 105, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 13, paddingHorizontal: 4 },
  sparkBar: { width: '10%', backgroundColor: '#6b9b73', borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  sparkLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  finalScore: { backgroundColor: '#0f1a14', borderRadius: 9, padding: 18, marginTop: 1, marginBottom: 20 },
  finalScoreRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 6 },
  finalScoreValue: { color: INK, fontFamily: 'Georgia', fontSize: 44 },
  finalScoreToPar: { color: INK, fontFamily: 'Georgia', fontSize: 26, marginLeft: 12 },
  underPar: { color: GREEN },
  overPar: { color: '#d9884e' },
  resultChips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 },
  resultChip: { backgroundColor: '#101412', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5, marginRight: 6, marginBottom: 6 },
  resultChipText: { color: INK, fontSize: 9, fontWeight: '700' },
  scorecard: { marginTop: 8, marginBottom: 22, borderRadius: 9, borderWidth: 1, borderColor: '#26302b', backgroundColor: '#101412', overflow: 'hidden' },
  scorecardRow: { flexDirection: 'row', alignItems: 'center', minHeight: 38, borderBottomWidth: 1, borderBottomColor: '#26302b' },
  scorecardHeader: { minHeight: 32, backgroundColor: '#141816' },
  scorecardTotal: { borderBottomWidth: 0, backgroundColor: '#141816' },
  scorecardCell: { flex: 1, textAlign: 'center', color: INK, fontSize: 12, fontVariant: ['tabular-nums'] },
  scorecardHoleCell: { textAlign: 'left', paddingLeft: 14 },
  scorecardHeaderText: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  scorecardScore: { fontWeight: '800' },
  throwByThrowTitle: { marginBottom: 4 },
  sessionModeTag: { color: GREEN, fontSize: 7, fontWeight: '800', letterSpacing: 0.6, marginRight: 8 },
  roundHole: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#26302b' },
  roundHoleHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 },
  roundHoleMapToggle: { color: GREEN, fontFamily: 'Arial', fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  roundHoleMap: { height: 260, marginTop: 4, marginBottom: 10, borderRadius: 9, overflow: 'hidden', backgroundColor: '#0d1410' },
  scorecardRowActive: { backgroundColor: '#0f1a14' },
  obMarker: { backgroundColor: '#a55343' },
  roundHoleTitle: { color: INK, fontFamily: 'Georgia', fontSize: 16 },
  roundHoleMeta: { color: GREEN, fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  roundThrow: { color: MUTED, fontSize: 10, lineHeight: 17 },
  statsGrid: { flexDirection: 'row', marginTop: 12, marginBottom: 25 },
  statBlock: { flex: 1, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: '#26302b' },
  statLabel: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  statValue: { color: INK, fontFamily: 'Georgia', fontSize: 23, marginTop: 7 },
  discStat: { flexDirection: 'row', alignItems: 'center', height: 48, borderBottomWidth: 1, borderBottomColor: '#26302b' },
  discStatName: { width: 82, color: INK, fontSize: 10, fontWeight: '700' },
  discStatTrack: { flex: 1, height: 5, backgroundColor: '#1a1f1c', borderRadius: 4, overflow: 'hidden' },
  discStatFill: { height: 5, backgroundColor: '#6c9a72', borderRadius: 4 },
  discStatValue: { width: 51, textAlign: 'right', color: MUTED, fontSize: 9, fontWeight: '700' },
  bagIntro: { backgroundColor: '#0f1a14', padding: 20, borderRadius: 9, marginTop: 6, marginBottom: 15 },
  bagHeadline: { color: INK, fontFamily: 'Georgia', fontSize: 28, marginTop: 10 },
  bagBody: { color: MUTED, fontSize: 11, lineHeight: 17, marginTop: 6 },
  bagItem: { minHeight: 67, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#26302b', paddingHorizontal: 4 },
  bagItemSelect: { flex: 1, minHeight: 66, flexDirection: 'row', alignItems: 'center' },
  bagItemSelected: { backgroundColor: '#16231c' },
  discSwatch: { width: 39, height: 39, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  discSwatchText: { color: '#e6ece8', fontSize: 12, fontWeight: '900' },
  bagItemCopy: { marginLeft: 12, flex: 1 },
  bagItemName: { color: INK, fontSize: 12, fontWeight: '800' },
  bagItemMeta: { color: MUTED, fontSize: 9, marginTop: 4 },
  bagArrow: { color: GREEN, fontSize: 17, paddingHorizontal: 9 },
});
