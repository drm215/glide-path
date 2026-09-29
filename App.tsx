import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Linking,
  Modal,
  Pressable,
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
  roundShareUrl,
  searchCourses,
  signIn as signInRequest,
  syncWithServer,
  type PublicCourse,
  type PublicCourseSummary,
} from './lib/api';
import { buildSyncRequest, clearSentTombstones, countPendingChanges, initialBagUpdatedAt, mergeCourses, mergeRounds, type SyncAccount, type SyncData } from './lib/sync';
import type { Course, CourseDetails, Disc, DiscInfo, GpsPoint, HoleLayout, Lie, SessionArchive, Shot, ThrowType, Tombstone } from './lib/types';

type SavedRound = { shots: Shot[]; hole: number; mode: 'Round' | 'Practice'; history?: SessionArchive[]; courseId?: string; active?: boolean; practiceFocus?: string };
type Screen = 'Home' | 'CourseBuilder' | 'HoleWizard' | 'BagBuilder' | 'Practice' | 'Round' | 'Insights' | 'Rounds' | 'RoundDetail' | 'Account' | 'FindCourses';
type MapRegion = { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };

// Keys keep the app's original name (Flight Notes) so existing on-device data still loads.
const STORAGE_KEY = 'flight-notes-round-v1';
const COURSES_KEY = 'flight-notes-courses-v1';
const BAG_KEY = 'flight-notes-bag-v1';
const BAG_DETAILS_KEY = 'flight-notes-bag-details-v1';
// Sync account (without its token) and pending sync bookkeeping.
const SYNC_KEY = 'flight-notes-sync-v1';
const SYNC_META_KEY = 'flight-notes-sync-meta-v1';
// The sign-in token lives in the iOS Keychain rather than plain app storage.
const TOKEN_KEY = 'glide-path-token';
// Wait this long after the last edit before syncing, so a burst of edits uploads once.
const SYNC_DEBOUNCE_MS = 4_000;
const DISCIT_API_URL = 'https://discit-api.fly.dev/disc';
const DISC_SEARCH_MIN_CHARS = 2;
const DISC_SEARCH_MAX_RESULTS = 12;
const INK = '#18231f';
const MUTED = '#737c70';
const GREEN = '#1d684c';
const PAPER = '#f6f5ee';
// Deliberately tighter than any map can render; the map clamps to its maximum zoom level.
const MAP_VIEW_WIDTH_FEET = 20;
const MAP_SCALE_BAR_OPTIONS_FEET = [5, 10, 25, 50, 100];
const METERS_PER_DEGREE = 111_320;
const EARTH_RADIUS_METERS = 6_371_000;
// Placeholder discs from earlier versions; removed from saved bags on load.
const LEGACY_DEFAULT_DISCS: Disc[] = ['Distance', 'Fairway', 'Midrange', 'Putter'];
const TYPE_OPTIONS: ThrowType[] = ['Drive', 'Approach', 'Putt'];
const PAR_OPTIONS = [2, 3, 4, 5, 6];
const LIE_OPTIONS: Lie[] = ['Fairway', 'Woods', 'Hazard', 'OB', 'Basket', 'Other'];
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
  `${shot.disc || 'No disc'} ${shot.type.toLowerCase()}`,
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
  const [pendingLie, setPendingLie] = useState<{ latitude: number; longitude: number; feet: number } | null>(null);
  const [logStep, setLogStep] = useState<1 | 2 | 3 | 4>(1);
  const [throwLie, setThrowLie] = useState<Lie>('Fairway');
  const [loaded, setLoaded] = useState(false);
  const [account, setAccount] = useState<SyncAccount | null>(null);
  const [bagUpdatedAt, setBagUpdatedAt] = useState(0);
  const [deletedCourses, setDeletedCourses] = useState<Tombstone[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [authMode, setAuthMode] = useState<'signIn' | 'register'>('signIn');
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

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(COURSES_KEY),
      AsyncStorage.getItem(BAG_KEY),
      AsyncStorage.getItem(BAG_DETAILS_KEY),
      AsyncStorage.getItem(SYNC_KEY),
      AsyncStorage.getItem(SYNC_META_KEY),
      SecureStore.getItemAsync(TOKEN_KEY).catch(() => null),
    ])
      .then(([roundValue, coursesValue, bagValue, bagDetailsValue, syncValue, syncMetaValue, token]) => {
        if (roundValue) {
          const saved = JSON.parse(roundValue) as SavedRound;
          setShots(saved.shots.map((shot) => ({ ...shot, hole: shot.hole ?? saved.hole, courseId: shot.courseId ?? saved.courseId })));
          setHole(saved.hole);
          setMode(saved.mode);
          setHistory(saved.history ?? []);
          // Rounds saved before `active` existed count as in progress if they have throws.
          setSessionActive(saved.active ?? saved.shots.length > 0);
          if (saved.practiceFocus) setPracticeFocus(saved.practiceFocus);
        }
        if (coursesValue) {
          const savedCourses = JSON.parse(coursesValue) as Course[];
          const normalizedCourses = savedCourses.map((course) => {
            const previousLayouts = course.layouts as { tee?: unknown; basket?: unknown; par?: unknown }[] | undefined;
            return {
              ...course,
              layouts: Array.from({ length: course.holes }, (_, index) => {
                const previous = previousLayouts?.[index];
                return { tee: isGpsPoint(previous?.tee) ? previous.tee : null, basket: isGpsPoint(previous?.basket) ? previous.basket : null, par: typeof previous?.par === 'number' ? previous.par : undefined };
              }),
            };
          });
          setCourses(normalizedCourses);
          const savedCourseId = roundValue ? (JSON.parse(roundValue) as SavedRound).courseId : undefined;
          const courseToSelect = normalizedCourses.find((course) => course.id === savedCourseId) ?? normalizedCourses[0];
          if (courseToSelect) setSelectedCourseId(courseToSelect.id);
        }
        if (bagValue) {
          const savedBag = (JSON.parse(bagValue) as Disc[]).filter((item) => !LEGACY_DEFAULT_DISCS.includes(item));
          setBag(savedBag);
          if (savedBag.length) setDisc(savedBag[0]);
        }
        if (bagDetailsValue) setBagDetails(JSON.parse(bagDetailsValue) as Record<Disc, DiscInfo>);
        if (syncValue && token) setAccount({ ...(JSON.parse(syncValue) as Omit<SyncAccount, 'token'>), token });
        const meta = syncMetaValue ? JSON.parse(syncMetaValue) as { bagUpdatedAt?: number; deletedCourses?: Tombstone[] } : {};
        setDeletedCourses(meta.deletedCourses ?? []);
        const savedBagCount = bagValue ? (JSON.parse(bagValue) as Disc[]).filter((item) => !LEGACY_DEFAULT_DISCS.includes(item)).length : 0;
        setBagUpdatedAt(initialBagUpdatedAt(meta.bagUpdatedAt, savedBagCount, nowMs()));
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const saved: SavedRound = { shots, hole, mode, history, courseId: selectedCourseId, active: sessionActive, practiceFocus };
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(saved)).catch(() => undefined);
  }, [history, hole, loaded, mode, practiceFocus, selectedCourseId, sessionActive, shots]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(COURSES_KEY, JSON.stringify(courses)).catch(() => undefined);
  }, [courses, loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(BAG_KEY, JSON.stringify(bag)).catch(() => undefined);
  }, [bag, loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(BAG_DETAILS_KEY, JSON.stringify(bagDetails)).catch(() => undefined);
  }, [bagDetails, loaded]);

  useEffect(() => {
    if (!loaded) return;
    if (!account) {
      AsyncStorage.removeItem(SYNC_KEY).catch(() => undefined);
      return;
    }
    const { token: _token, ...stored } = account;
    AsyncStorage.setItem(SYNC_KEY, JSON.stringify(stored)).catch(() => undefined);
  }, [account, loaded]);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(SYNC_META_KEY, JSON.stringify({ bagUpdatedAt, deletedCourses })).catch(() => undefined);
  }, [bagUpdatedAt, deletedCourses, loaded]);

  // Sync runs from timers and app-state events, so it reads the latest values from here.
  const syncData: SyncData = { courses, history, bag, bagDetails, bagUpdatedAt, deletedCourses };
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
    const body = buildSyncRequest(data, current);
    try {
      const result = await syncWithServer(current.token, body);
      setCourses((local) => mergeCourses(local, result.courses));
      setHistory((local) => mergeRounds(local, result.rounds));
      setDeletedCourses((local) => clearSentTombstones(local, body.courses));
      if (result.bag && result.bag.updatedAt > latestSync.current.data.bagUpdatedAt) {
        setBag(result.bag.discs);
        setBagDetails(result.bag.details);
        setBagUpdatedAt(result.bag.updatedAt);
      }
      setAccount((acct) => (acct?.token === current.token ? { ...acct, cursor: result.cursor, pushedThrough: startedAt, lastSyncedAt: nowMs() } : acct));
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
  }, [loaded, account, pendingChanges, courses, history, bag, bagDetails, deletedCourses]);

  // User edits to courses go through here so each changed course gets a fresh edit time for sync.
  const updateCourses = (updater: (current: Course[]) => Course[]) => {
    const stamp = nowMs();
    setCourses((existing) => updater(existing).map((course) => (existing.includes(course) ? course : { ...course, updatedAt: stamp })));
  };

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
  const viewedCourse = courses.find((course) => course.id === viewedSession?.courseId);
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
    const summary = scoreSummary(session.shots, courses.find((course) => course.id === session.courseId));
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
  const totalFeet = allShots.reduce((total, shot) => total + shot.feet, 0);
  const averageFeet = allShots.length ? Math.round(totalFeet / allShots.length) : 0;
  const recentShots = allShots.slice(-8);
  const longestRecentThrow = Math.max(1, ...recentShots.map((shot) => shot.feet));
  const selectedCourse = courses.find((course) => course.id === selectedCourseId) ?? courses[0];
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
      updateCourses((current) => current.map((course) => {
        if (course.id !== courseId) return course;
        const layouts = Array.from({ length: course.holes }, (_, index) => course.layouts?.[index] ?? { tee: null, basket: null });
        const layout = layouts[targetHole - 1] ?? { tee: null, basket: null };
        layouts[targetHole - 1] = { ...layout, [target]: point };
        return { ...course, layouts };
      }));
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
    const courseId = selectedCourse.id;
    updateCourses((current) => current.map((course) => {
      if (course.id !== courseId) return course;
      const layouts = Array.from({ length: course.holes }, (_, index) => course.layouts?.[index] ?? { tee: null, basket: null });
      layouts[targetHole - 1] = { ...layouts[targetHole - 1], par };
      return { ...course, layouts };
    }));
  };

  // Captures the player's GPS position at the disc, then asks for disc, throw type and quality.
  const startLogThrow = async () => {
    if (loggingThrow) return;
    setLoggingThrow(true);
    setRoundMessage('Getting a GPS fix at your lie…');
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationAllowed(false);
        setRoundMessage(permission.canAskAgain ? 'Location permission is needed to log where your disc landed.' : 'Enable location access for Glide Path in Settings, then try again.');
        return;
      }
      setLocationAllowed(true);
      if (!(await Location.hasServicesEnabledAsync())) {
        setRoundMessage('Turn on Location Services, then log the throw again.');
        return;
      }
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: true });
      const lie = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
      const previousShot = activeShots.findLast((shot) => shot.latitude !== undefined && shot.longitude !== undefined);
      const previous = previousShot ? { latitude: previousShot.latitude!, longitude: previousShot.longitude! } : selectedHoleLayout?.tee;
      const feet = previous ? Math.max(1, Math.round(feetBetween(previous, lie))) : 0;
      setPendingLie({ ...lie, feet });
      if (!disc && bag.length) setDisc(bag[0]);
      setLogStep(1);
      setRoundMessage('');
    } catch {
      setRoundMessage('Could not get a GPS fix. Wait a moment and try again.');
    } finally {
      setLoggingThrow(false);
    }
  };

  const cancelLogThrow = () => setPendingLie(null);

  const saveThrow = (quality: number, lie: Lie = throwLie) => {
    if (!pendingLie) return;
    const { latitude, longitude, feet } = pendingLie;
    setShots((current) => [...current, { x: 0.5, y: 0.5, feet, disc, type: throwType, hole, courseId: selectedCourse?.id, latitude, longitude, lie, quality, qualityMax: QUALITY_MAX }]);
    setThrowType('Approach');
    setPendingLie(null);
    if (lie !== 'Basket') return;
    // A made basket finishes the hole.
    const throwCount = holeStrokes + 1;
    const holeCount = selectedCourse?.holes ?? 18;
    setThrowLie('Fairway');
    if (hole >= holeCount) {
      setRoundMessage(`Hole ${hole} complete in ${throwCount} ${throwCount === 1 ? 'stroke' : 'strokes'}. That was the last hole.`);
      promptLastHoleComplete();
      return;
    }
    setHole(hole + 1);
    setThrowType('Drive');
    setRoundMessage(`Hole ${hole} complete in ${throwCount} ${throwCount === 1 ? 'stroke' : 'strokes'}. On to hole ${hole + 1}.`);
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
    setThrowType(shots.some((shot) => shot.hole === previousHole) ? 'Approach' : 'Drive');
  };

  // Moves the current session's throws into history so a new one can begin.
  const archiveSession = () => {
    const id = shots.length ? newSessionId() : null;
    if (id) setHistory((current) => [...current, { id, mode, courseName: selectedCourse?.name ?? 'Practice area', courseId: selectedCourse?.id, shots, updatedAt: nowMs() }]);
    setShots([]);
    setSessionActive(false);
    return id;
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

  const beginSession = (nextMode: 'Round' | 'Practice') => {
    archiveSession();
    setMode(nextMode);
    setHole(1);
    setThrowType('Drive');
    setThrowLie('Fairway');
    setRoundMessage('');
    setSessionActive(true);
    setScreen('Round');
  };

  // Starting over while a session is in progress needs confirmation; the old session goes to history.
  const confirmNewSession = (nextMode: 'Round' | 'Practice') => {
    if (!sessionActive) {
      beginSession(nextMode);
      return;
    }
    Alert.alert(
      `Start a new ${nextMode === 'Round' ? 'round' : 'practice session'}?`,
      `Your ${mode === 'Round' ? 'round' : 'practice session'} in progress (${shots.length} ${shots.length === 1 ? 'throw' : 'throws'}) will be ended and saved to your session history.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start new', style: 'destructive', onPress: () => beginSession(nextMode) },
      ],
    );
  };

  const startRound = () => {
    if (!selectedCourse) {
      Alert.alert('Create a course first', 'Add a course in Course Builder before starting a round.');
      return;
    }
    confirmNewSession('Round');
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

  // New courses start with one hole; holes are added while mapping until the user finishes.
  const addCourse = () => {
    const name = courseName.trim();
    if (!name) return;
    const course: Course = { id: newSessionId(), name, holes: 1, layouts: [{ tee: null, basket: null }] };
    updateCourses((current) => [...current, course]);
    setCourseName('');
    openHoleWizard(course);
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

  const submitAuth = async () => {
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
      await SecureStore.setItemAsync(TOKEN_KEY, result.token);
      setAccount({ token: result.token, user: result.user, cursor: 0, pushedThrough: 0 });
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
    const course: Course = { id: newSessionId(), name: source.name, holes: source.holes, layouts, address, street, city, state, phone, email, website, notes, sourceUid: source.uid };
    updateCourses((current) => [...current, course]);
    setSelectedCourseId(course.id);
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
        {layout?.basket && <Marker coordinate={layout.basket} title={`Hole ${holeNumber} basket`} pinColor="#d77d42" />}
        {throws.map((item) => <Marker key={`${item.index}-${item.coordinate.latitude}`} coordinate={item.coordinate} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} title={`Throw ${item.index + 1}`} description={formatThrowDetail(item.shot)}><View style={[styles.shotMarker, item.shot.lie === 'OB' && styles.obMarker]}><Text style={styles.shotPinText}>{item.index + 1}</Text></View></Marker>)}
      </MapView>
      {!viewedCourse && <View pointerEvents="none" style={styles.boardCaption}><Text style={styles.boardCaptionText}>COURSE DELETED · TEE AND BASKET UNAVAILABLE</Text></View>}
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
    updateCourses((current) => current.map((course) => course.id === courseId
      ? { ...course, holes: course.holes + 1, layouts: [...Array.from({ length: course.holes }, (_, index) => course.layouts?.[index] ?? { tee: null, basket: null }), { tee: null, basket: null }] }
      : course));
  };

  const addWizardHole = () => {
    if (!selectedCourse) return;
    const newHole = selectedCourse.holes + 1;
    addHoleToCourse(selectedCourse.id);
    moveWizardHole(newHole, true);
  };

  const deleteHole = (course: Course, holeNumber: number) => {
    if (course.holes <= 1) {
      Alert.alert('Keep one hole', 'A course needs at least one hole. Delete the course if you no longer need it.');
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
            updateCourses((current) => current.map((item) => item.id === course.id
              ? { ...item, holes: item.holes - 1, layouts: item.layouts?.filter((_, index) => index !== holeNumber - 1) }
              : item));
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
            if (disc === name) setDisc(remaining[0] ?? '');
          },
        },
      ],
    );
  };

  const addCatalogDisc = (info: DiscInfo) => {
    const name = bag.includes(info.name) && bagDetails[info.name]?.brand !== info.brand ? `${info.name} (${info.brand})` : info.name;
    if (!bag.includes(name)) setBag((current) => [...current, name]);
    setBagDetails((current) => ({ ...current, [name]: info }));
    setBagUpdatedAt(nowMs());
    setDisc(name);
    setBagEntry('');
  };

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <View style={[styles.appFrame, compact && styles.appFrameCompact]}>
        <View style={styles.topline}>
          <Pressable onPress={() => setScreen('Home')} style={styles.brand} accessibilityRole="button" accessibilityLabel="Glide Path home">
            <View style={styles.brandMark}><Text style={styles.brandGlyph}>G</Text></View>
            <View style={styles.brandCopy}>
              <Text style={styles.brandName}>GLIDE PATH</Text>
              <Text style={styles.brandSub}>FIELD LOG · EST. 2025</Text>
            </View>
          </Pressable>
          <Pressable onPress={() => setScreen('Account')} style={[styles.avatar, account && styles.avatarSignedIn]} accessibilityRole="button" accessibilityLabel={account ? `Account: ${account.user.displayName}` : 'Sign in'}>
            <Text style={[styles.avatarText, account && styles.avatarTextSignedIn]}>{account ? initialsFor(account.user.displayName) : '?'}</Text>
          </Pressable>
        </View>

        <View style={styles.pageHeading}>
          <View>
            <Text style={styles.eyebrow}>{screen === 'Home' ? 'DISC GOLF FIELD LOG' : screen === 'HoleWizard' ? `${selectedCourse?.name ?? 'COURSE'} · SATELLITE MAP` : screen === 'Round' ? 'ON THE COURSE' : screen === 'Practice' ? 'FOCUSED SESSION' : screen === 'Rounds' ? 'PREVIOUS SESSIONS' : screen === 'Account' ? 'SYNC & SHARING' : screen === 'FindCourses' ? 'COURSE DIRECTORY' : screen === 'RoundDetail' ? (showingRoundSummary ? 'ROUND COMPLETE' : viewedSession ? formatSessionDate(viewedSession).toUpperCase() : 'ROUND') : 'YOUR GAME, IN FOCUS'}</Text>
            <Text style={styles.title}>{screen === 'Home' ? 'Ready when you are.' : screen === 'CourseBuilder' ? 'Course builder.' : screen === 'HoleWizard' ? `Hole ${String(builderHole).padStart(2, '0')}.` : screen === 'BagBuilder' ? 'Bag builder.' : screen === 'Practice' ? 'Practice.' : screen === 'Round' ? 'Keep the line.' : screen === 'Rounds' ? 'Rounds.' : screen === 'Account' ? (account ? 'Your account.' : 'Sign in.') : screen === 'FindCourses' ? 'Find courses.' : screen === 'RoundDetail' ? `${viewedSession?.courseName ?? 'Round'}.` : 'The long view.'}</Text>
          </View>
          {screen !== 'Home' && (() => {
            const backToRounds = screen === 'RoundDetail' && !showingRoundSummary;
            return <Pressable onPress={() => setScreen(screen === 'HoleWizard' ? 'CourseBuilder' : backToRounds ? 'Rounds' : 'Home')} style={styles.homeButton} accessibilityLabel={screen === 'HoleWizard' ? 'Return to course builder' : backToRounds ? 'Return to rounds' : 'Return to main menu'}><Text style={styles.homeButtonText}>{screen === 'HoleWizard' ? '‹ COURSES' : backToRounds ? '‹ ROUNDS' : '⌂ MENU'}</Text></Pressable>;
          })()}
        </View>

        {screen === 'Home' ? (
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.menuIntro}>
              <Text style={styles.menuIntroLabel}>YOUR NEXT SESSION</Text>
              <Text style={styles.menuIntroTitle}>{selectedCourse?.name ?? 'Build your first course'}</Text>
              <Text style={styles.menuIntroCopy}>{selectedCourse ? `${selectedCourse.holes} holes · ${shots.length} throws saved on this device` : 'Add a course, build your bag, or head to practice.'}</Text>
            </View>
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
                <Text style={styles.menuNumber}>06</Text><View style={styles.menuItemCopy}><Text style={styles.menuTitle}>Session insights</Text><Text style={styles.menuSubtitle}>Distances and disc averages</Text></View><Text style={styles.menuArrow}>›</Text>
              </Pressable>
              <Pressable onPress={startRound} style={[styles.menuItem, !sessionActive && styles.menuItemPrimary]}>
                <Text style={[styles.menuNumber, !sessionActive && styles.menuNumberPrimary]}>07</Text><View style={styles.menuItemCopy}><Text style={[styles.menuTitle, !sessionActive && styles.menuTitlePrimary]}>{sessionActive ? 'Start a new round' : 'Start a round'}</Text><Text style={[styles.menuSubtitle, !sessionActive && styles.menuSubtitlePrimary]}>Track throws hole by hole</Text></View><Text style={[styles.menuArrow, !sessionActive && styles.menuArrowPrimary]}>↗</Text>
              </Pressable>
            </View>
          </ScrollView>
        ) : screen === 'CourseBuilder' ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.builderPanel}>
              <Text style={styles.builderLabel}>COURSE NAME</Text>
              <TextInput value={courseName} onChangeText={setCourseName} placeholder="e.g. Cedar Grove" placeholderTextColor="#92988c" style={styles.builderInput} returnKeyType="done" />
              <Pressable onPress={addCourse} style={[styles.primaryButton, !courseName.trim() && styles.disabledButton]}><Text style={styles.primaryButtonText}>CREATE COURSE & MAP HOLE 1 ↗</Text></Pressable>
              <Text style={styles.builderHint}>Add holes one at a time while you map, then tap Finish.</Text>
            </View>
            <Text style={styles.builderSectionTitle}>Your courses</Text>
            {courses.map((course) => <View key={course.id} style={[styles.courseItem, selectedCourseId === course.id && styles.courseItemSelected]}><Pressable onPress={() => { setSelectedCourseId(course.id); setBuilderHole(1); }} style={styles.courseItemSelect}><View style={styles.courseItemCopy}><Text style={styles.courseItemName}>{course.name}</Text><Text style={styles.courseItemMeta}>{course.holes} holes · {selectedCourseId === course.id ? 'Selected' : 'Tap to select'}</Text></View><Text style={styles.courseSelectedMark}>{selectedCourseId === course.id ? '✓' : '○'}</Text></Pressable><Pressable onPress={() => deleteCourse(course)} accessibilityRole="button" accessibilityLabel={`Delete ${course.name}`} style={styles.deleteButton}><Text style={styles.deleteButtonText}>DELETE</Text></Pressable></View>)}
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
              {selectedCourseStats && <View style={styles.courseStatsGrid}>
                <View style={styles.courseStat}><Text style={styles.statLabel}>HOLES</Text><Text style={styles.courseStatValue}>{selectedCourseStats.holes}</Text><Text style={styles.courseStatNote}>{selectedCourseStats.mappedHoles} mapped</Text></View>
                <View style={styles.courseStat}><Text style={styles.statLabel}>PAR</Text><Text style={styles.courseStatValue}>{selectedCourseStats.parHoles ? selectedCourseStats.par : '—'}</Text><Text style={styles.courseStatNote}>{selectedCourseStats.parHoles === selectedCourseStats.holes ? 'All holes' : `${selectedCourseStats.parHoles} of ${selectedCourseStats.holes} holes set`}</Text></View>
                <View style={styles.courseStat}><Text style={styles.statLabel}>DISTANCE</Text><Text style={styles.courseStatValue}>{selectedCourseStats.mappedHoles ? `${selectedCourseStats.distanceFeet.toLocaleString()} ft` : '—'}</Text><Text style={styles.courseStatNote}>Tee to basket, mapped holes</Text></View>
                <View style={styles.courseStat}><Text style={styles.statLabel}>ELEVATION CHANGE</Text><Text style={styles.courseStatValue}>{selectedCourseStats.elevationFeet === null ? '—' : `${selectedCourseStats.elevationFeet} ft`}</Text><Text style={styles.courseStatNote}>{selectedCourseStats.elevationFeet === null ? 'Save tee and basket points to measure' : 'Highest to lowest point'}</Text></View>
              </View>}
              <Text style={styles.builderLabel}>STREET</Text>
              <TextInput value={courseStreet(selectedCourse)} onChangeText={(street) => updateCourseDetails(selectedCourse.id, { street, address: undefined })} placeholder="123 Park Road" placeholderTextColor="#92988c" style={styles.builderInput} textContentType="streetAddressLine1" />
              <View style={styles.cityStateRow}>
                <View style={styles.cityField}>
                  <Text style={[styles.builderLabel, styles.detailLabel]}>CITY</Text>
                  <TextInput value={selectedCourse.city ?? ''} onChangeText={(city) => updateCourseDetails(selectedCourse.id, { city })} placeholder="City" placeholderTextColor="#92988c" style={styles.builderInput} textContentType="addressCity" />
                </View>
                <View style={styles.stateField}>
                  <Text style={[styles.builderLabel, styles.detailLabel]}>STATE</Text>
                  <TextInput value={selectedCourse.state ?? ''} onChangeText={(state) => updateCourseDetails(selectedCourse.id, { state: state.toUpperCase() })} placeholder="ST" placeholderTextColor="#92988c" style={styles.builderInput} autoCapitalize="characters" autoCorrect={false} maxLength={2} textContentType="addressState" />
                </View>
              </View>
              <Text style={[styles.builderLabel, styles.detailLabel]}>PHONE</Text>
              <TextInput value={selectedCourse.phone ?? ''} onChangeText={(phone) => updateCourseDetails(selectedCourse.id, { phone: formatPhone(phone) })} placeholder="(555) 123-4567" placeholderTextColor="#92988c" style={styles.builderInput} keyboardType="phone-pad" textContentType="telephoneNumber" />
              <Text style={[styles.builderLabel, styles.detailLabel]}>EMAIL</Text>
              <TextInput value={selectedCourse.email ?? ''} onChangeText={(email) => updateCourseDetails(selectedCourse.id, { email })} placeholder="contact@example.com" placeholderTextColor="#92988c" style={styles.builderInput} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} textContentType="emailAddress" />
              <Text style={[styles.builderLabel, styles.detailLabel]}>WEBSITE</Text>
              <TextInput value={selectedCourse.website ?? ''} onChangeText={(website) => updateCourseDetails(selectedCourse.id, { website })} placeholder="udisc.com/courses/…" placeholderTextColor="#92988c" style={styles.builderInput} keyboardType="url" autoCapitalize="none" autoCorrect={false} textContentType="URL" />
              <Text style={[styles.builderLabel, styles.detailLabel]}>INFO TO KNOW</Text>
              <TextInput value={selectedCourse.notes ?? ''} onChangeText={(notes) => updateCourseDetails(selectedCourse.id, { notes })} placeholder="Parking, fees, hours, restrooms, mandos, water hazards…" placeholderTextColor="#92988c" style={[styles.builderInput, styles.notesInput]} multiline textAlignVertical="top" />
              {renderCourseLinks(selectedCourse)}
            </View>}
            {selectedCourse && <View style={styles.mapEditor}><View style={styles.mapEditorHeading}><Text style={styles.builderSectionTitle}>Hole layouts</Text><Text style={styles.mapProgress}>{mappedHoleCount}/{selectedCourse.holes} MAPPED</Text></View><Text style={styles.mapInstruction}>Map each hole with satellite imagery and on-site GPS capture.</Text><Pressable onPress={() => openHoleWizard(selectedCourse)} style={styles.primaryButton}><Text style={styles.primaryButtonText}>MAP SELECTED COURSE ↗</Text></Pressable>
              <View style={[styles.mapEditorHeading, styles.parEditorHeading]}><Text style={styles.builderSectionTitle}>Hole pars</Text><Text style={styles.mapProgress}>PAR {selectedCourse.layouts?.reduce((sum, layout) => sum + (layout.par ?? 0), 0) ?? 0}</Text></View>
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
        ) : screen === 'HoleWizard' ? (
          <View style={styles.holeWizard}>
            <View style={styles.wizardProgress}><View><Text style={styles.editorHoleName}>HOLE {String(builderHole).padStart(2, '0')} OF {String(selectedCourse?.holes ?? 0).padStart(2, '0')}</Text><Text style={[styles.mapProgress, styles.wizardMappedCount]}>{mappedHoleCount}/{selectedCourse?.holes ?? 0} MAPPED</Text></View>{selectedCourse && <Pressable onPress={() => deleteHole(selectedCourse, builderHole)} accessibilityRole="button" accessibilityLabel={`Delete hole ${builderHole}`} style={styles.deleteHoleButton}><Text style={styles.deleteButtonText}>DELETE HOLE</Text></Pressable>}</View>
            <View style={styles.satelliteFrame} onLayout={(event) => setMapViewportWidth(event.nativeEvent.layout.width)}>
              {mapRegion ? <MapView style={styles.satelliteMap} mapType="satellite" region={mapRegion} onRegionChangeComplete={setMapRegion} showsUserLocation={locationAllowed} showsMyLocationButton={false}>
                {editorHoleLayout?.tee && <Marker coordinate={editorHoleLayout.tee} title={`Hole ${builderHole} tee box`} description={`GPS accuracy ${editorHoleLayout.tee.accuracy ?? 'unknown'} meters`} pinColor="#1d684c" />}
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
              <Pressable onPress={() => setScreen('CourseBuilder')} style={[styles.wizardNavButton, styles.wizardNavFinish]}><Text style={styles.wizardNavFinishText}>FINISH ✓</Text></Pressable>
              <Pressable onPress={() => builderHole < (selectedCourse?.holes ?? 1) ? moveWizardHole(builderHole + 1) : addWizardHole()} style={[styles.wizardNavButton, styles.wizardNavNext]}><Text style={[styles.wizardNavText, styles.wizardNavNextText]}>{builderHole < (selectedCourse?.holes ?? 1) ? 'NEXT HOLE ›' : '+ ADD HOLE'}</Text></Pressable>
            </View>
          </View>
        ) : screen === 'BagBuilder' ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.builderPanel}>
              <Text style={styles.builderLabel}>ADD A DISC</Text>
              <View style={styles.addDiscRow}><TextInput value={bagEntry} onChangeText={setBagEntry} onSubmitEditing={addDisc} placeholder="Disc name or mold" placeholderTextColor="#92988c" style={[styles.builderInput, styles.discInput]} returnKeyType="done" /><Pressable onPress={addDisc} style={styles.addDiscButton}><Text style={styles.addDiscButtonText}>ADD</Text></Pressable></View>
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
            {bag.map((item, index) => <View key={`${item}-${index}`} style={styles.bagItem}><View style={styles.bagItemSelect}><View style={[styles.discSwatch, { backgroundColor: bagDetails[item]?.background_color ?? ['#e08b48', '#619276', '#8ba4a0', '#d4d1c3'][index % 4] }]}><Text style={[styles.discSwatchText, bagDetails[item]?.color ? { color: bagDetails[item].color } : null]}>{item.charAt(0).toUpperCase()}</Text></View><View style={styles.bagItemCopy}><Text style={styles.bagItemName}>{item}</Text>{bagDetails[item] && <Text style={styles.bagItemMeta}>{formatDiscMeta(bagDetails[item])}</Text>}{shots.some((shot) => shot.disc === item) && <Text style={styles.bagItemMeta}>{shots.filter((shot) => shot.disc === item).length} throws logged</Text>}</View></View><Pressable onPress={() => deleteDisc(item)} accessibilityRole="button" accessibilityLabel={`Remove ${item} from bag`} style={styles.deleteButton}><Text style={styles.deleteButtonText}>DELETE</Text></Pressable></View>)}
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
              <View style={styles.courseLabel}><Text style={styles.holeLabel}>{mode === 'Practice' ? `${practiceFocus.toUpperCase()} PRACTICE` : 'PLAYING AT'}</Text><Text style={styles.courseLabelName}>{selectedCourse?.name ?? 'Practice area'}</Text></View>
              <View style={styles.roundHoleNav}>
                <Pressable onPress={goToPreviousHole} disabled={hole <= 1} style={[styles.roundHoleArrow, hole <= 1 && styles.holeNavDisabled]} accessibilityRole="button" accessibilityLabel="Previous hole"><Text style={styles.holeNavArrow}>‹</Text></Pressable>
                <View style={styles.holeSelector}><Text style={styles.holeLabel}>HOLE</Text><Text style={styles.holeNumber}>{String(hole).padStart(2, '0')}<Text style={styles.holeTotal}> / {selectedCourse?.holes ?? 18}</Text></Text></View>
                <Pressable onPress={startNextHole} style={styles.roundHoleArrow} accessibilityRole="button" accessibilityLabel="Next hole"><Text style={styles.holeNavArrow}>›</Text></Pressable>
              </View>
            </View>

            <View style={styles.scoreRow}>
              <View><Text style={styles.scoreLabel}>HOLE SCORE</Text><Text style={styles.scoreValue}>{String(holeStrokes).padStart(2, '0')}</Text></View>
              <View style={styles.scoreDivider} />
              <View><Text style={styles.scoreLabel}>DISTANCE</Text><Text style={styles.scoreValue}>{holeFeet}<Text style={styles.scoreUnit}> ft</Text></Text></View>
              <View style={styles.parPill}><Text style={styles.parText}>{mode === 'Practice' ? 'OPEN PLAY' : `PAR ${selectedHoleLayout?.par ?? '—'}`}</Text></View>
            </View>
            {mode === 'Round' && <View style={styles.roundTotals}>
              <View style={styles.roundTotal}><Text style={styles.scoreLabel}>ROUND SCORE</Text><Text style={styles.roundTotalValue}>{roundScore.strokes}</Text></View>
              <View style={styles.roundTotal}><Text style={styles.scoreLabel}>TO PAR</Text><Text style={styles.roundTotalValue}>{roundScore.toPar === null ? '—' : formatScoreToPar(roundScore.toPar)}</Text></View>
              <View style={styles.roundTotal}><Text style={styles.scoreLabel}>THRU</Text><Text style={styles.roundTotalValue}>{roundScore.holesCompleted}</Text></View>
            </View>}

            <View style={styles.sectionTitleRow}>
              <Text style={styles.sectionTitle}>Hole layout</Text>
              <View style={styles.mapHint}><View style={styles.mapHintDot} /><Text style={styles.mapHintText}>WALK TO YOUR LIE</Text></View>
            </View>

            {roundMapRegion ? <View style={styles.roundMapFrame}>
              <MapView key={`${selectedCourse?.id}-${hole}`} style={styles.satelliteMap} mapType="satellite" initialRegion={roundMapRegion} showsUserLocation={locationAllowed} showsMyLocationButton={false}>
                {selectedHoleLayout?.tee && selectedHoleLayout.basket && <Polyline coordinates={[selectedHoleLayout.tee, selectedHoleLayout.basket]} strokeColor="#ffffff" strokeWidth={2} lineDashPattern={[6, 4]} />}
                {throwPath.length > 1 && <Polyline coordinates={throwPath} strokeColor="#df8547" strokeWidth={3} />}
                {selectedHoleLayout?.tee && <Marker coordinate={selectedHoleLayout.tee} title={`Hole ${hole} tee box`} pinColor="#1d684c" />}
                {selectedHoleLayout?.basket && <Marker coordinate={selectedHoleLayout.basket} title={`Hole ${hole} basket`} pinColor="#d77d42" />}
                {mappedShots.map((shot) => <Marker key={`${shot.index}-${shot.coordinate.latitude}`} coordinate={shot.coordinate} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}><View style={styles.shotMarker}><Text style={styles.shotPinText}>{shot.index + 1}</Text></View></Marker>)}
              </MapView>
              <View pointerEvents="none" style={styles.boardCaption}><Text style={styles.boardCaptionText}>{(selectedCourse?.name ?? 'PRACTICE AREA').toUpperCase()}</Text><Text style={styles.boardScale}>SATELLITE</Text></View>
            </View> : <View style={[styles.roundMapFrame, styles.mapUnavailable]}><Text style={styles.mapUnavailableTitle}>Hole not mapped yet</Text><Text style={styles.mapUnavailableText}>Map this hole in Course builder to see it on the satellite map. You can still log throws.</Text></View>}
            {selectedHoleDistance !== null && <View style={[styles.holeDistance, styles.roundHoleDistance]}><Text style={styles.holeDistanceLabel}>TEE TO BASKET</Text><Text style={styles.holeDistanceValue}>{selectedHoleDistance} ft</Text></View>}

            <Pressable onPress={startLogThrow} disabled={loggingThrow} style={[styles.logThrowButton, loggingThrow && styles.disabledButton]} accessibilityRole="button"><Text style={styles.logThrowButtonText}>{loggingThrow ? 'GETTING GPS…' : `LOG THROW ${score + 1}`}</Text><Text style={styles.logThrowButtonHint}>Stand where your disc landed, then tap</Text></Pressable>
            {roundMessage ? <Text style={styles.gpsMessage}>{roundMessage}</Text> : null}

            <View style={styles.latestRow}>
              <View><Text style={styles.latestEyebrow}>LATEST THROW</Text><Text style={styles.latestText}>{latestShot ? [latestShot.feet ? `${latestShot.feet} ft` : 'Distance n/a', `${latestShot.disc || 'No disc'} ${latestShot.type.toLowerCase()}`, formatLie(latestShot.lie), latestShot.quality ? `quality ${formatQuality(latestShot)}` : null].filter(Boolean).join(' · ') : 'Walk to your disc and tap Log throw'}</Text></View>
              {activeShots.length > 0 && <Pressable accessibilityLabel="Undo last throw" onPress={() => setShots((current) => { const lastActiveIndex = current.findLastIndex((shot) => shot.hole === hole); return current.filter((_, index) => index !== lastActiveIndex); })} style={styles.undoButton}><Text style={styles.undoText}>UNDO</Text></Pressable>}
            </View>
            <Pressable onPress={finishHole} style={styles.finishButton}><Text style={styles.finishButtonText}>{mode === 'Practice' ? 'NEXT TARGET' : 'FINISH HOLE'} <Text style={styles.finishArrow}>↗</Text></Text></Pressable>
            <Pressable onPress={endSession} style={styles.endSessionButton} accessibilityRole="button"><Text style={styles.endSessionText}>END {mode === 'Round' ? 'ROUND' : 'PRACTICE'}</Text></Pressable>
            {selectedCourse ? <View style={styles.roundCourseInfo}>
              <Pressable onPress={() => setShowCourseInfo((current) => !current)} style={styles.roundCourseInfoHeader} accessibilityRole="button" accessibilityState={{ expanded: showCourseInfo }}>
                <Text style={styles.sectionTitle}>Course info</Text><Text style={styles.menuArrow}>{showCourseInfo ? '−' : '+'}</Text>
              </Pressable>
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
              <View style={[styles.typeRow, styles.authTabs]}>
                {(['signIn', 'register'] as const).map((item) => <Pressable key={item} onPress={() => { setAuthMode(item); setAuthError(''); }} style={[styles.typeButton, styles.sheetTypeButton, authMode === item && styles.typeButtonSelected]}><Text style={[styles.typeText, authMode === item && styles.typeTextSelected]}>{item === 'signIn' ? 'Sign in' : 'Create account'}</Text></Pressable>)}
              </View>
              <View style={styles.builderPanel}>
                {authMode === 'register' && <>
                  <Text style={styles.builderLabel}>NAME</Text>
                  <TextInput value={authName} onChangeText={setAuthName} placeholder="Shown on courses you publish" placeholderTextColor="#92988c" style={styles.builderInput} textContentType="name" autoComplete="name" />
                </>}
                <Text style={[styles.builderLabel, authMode === 'register' && styles.detailLabel]}>EMAIL</Text>
                <TextInput value={authEmail} onChangeText={setAuthEmail} placeholder="you@example.com" placeholderTextColor="#92988c" style={styles.builderInput} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} textContentType="emailAddress" autoComplete="email" />
                <Text style={[styles.builderLabel, styles.detailLabel]}>PASSWORD</Text>
                <TextInput value={authPassword} onChangeText={setAuthPassword} onSubmitEditing={submitAuth} placeholder={authMode === 'register' ? 'At least 8 characters' : 'Password'} placeholderTextColor="#92988c" style={styles.builderInput} secureTextEntry textContentType={authMode === 'register' ? 'newPassword' : 'password'} autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} returnKeyType="go" />
                {authError ? <Text style={styles.authError}>{authError}</Text> : null}
                <Pressable onPress={submitAuth} disabled={authBusy} style={[styles.primaryButton, authBusy && styles.disabledButton]}><Text style={styles.primaryButtonText}>{authBusy ? 'PLEASE WAIT…' : authMode === 'register' ? 'CREATE ACCOUNT' : 'SIGN IN'}</Text></Pressable>
                {authBusy && <Text style={styles.builderHint}>The server can take up to a minute to wake if it hasn’t been used recently.</Text>}
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
                  <TextInput value={findQuery} onChangeText={setFindQuery} onSubmitEditing={() => runCourseSearch(false)} placeholder="e.g. Cedar Grove or PA" placeholderTextColor="#92988c" style={[styles.builderInput, styles.discInput]} returnKeyType="search" />
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
            {pastSessions.map((session) => <Pressable key={session.id} onPress={() => { setViewedSessionId(session.id); setExpandedHole(null); setShowingRoundSummary(false); setScreen('RoundDetail'); }} style={styles.courseItem} accessibilityRole="button">
              <View style={styles.courseItemCopy}><Text style={styles.courseItemName}>{session.courseName}</Text><Text style={styles.courseItemMeta}>{formatSessionDate(session)} · {sessionSummary(session)}</Text></View>
              {session.mode === 'Practice' && <Text style={styles.sessionModeTag}>PRACTICE</Text>}
              <Text style={styles.menuArrow}>›</Text>
            </Pressable>)}
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
                  viewedScore?.holesWithPar ? `Par ${viewedPar}` : null,
                  `${viewedSession.shots.reduce((sum, shot) => sum + shot.feet, 0).toLocaleString()} ft thrown`,
                ].filter(Boolean).join(' · ')}</Text>
                {viewedResults.length > 0 && <View style={styles.resultChips}>{viewedResults.map((result) => <View key={result.label} style={styles.resultChip}><Text style={styles.resultChipText}>{result.count} {result.label}{result.count === 1 || result.label.endsWith('+') || result.label.endsWith('better') ? '' : 's'}</Text></View>)}</View>}
              </View>
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
              <Text style={[styles.sectionTitle, styles.throwByThrowTitle]}>Throw by throw</Text>
              <Text style={styles.mapInstruction}>Tap a hole to see where each throw was logged.</Text>
              {viewedHoles.map((item) => <View key={item.hole} style={styles.roundHole} onLayout={(event) => { holeSectionOffsets.current[item.hole] = event.nativeEvent.layout.y; }}>
                <Pressable onPress={() => toggleRoundHoleMap(item.hole)} style={styles.roundHoleHeader} accessibilityRole="button" accessibilityState={{ expanded: expandedHole === item.hole }}>
                  <Text style={styles.roundHoleTitle}>Hole {String(item.hole).padStart(2, '0')} <Text style={styles.roundHoleMapToggle}>{expandedHole === item.hole ? '− MAP' : '+ MAP'}</Text></Text>
                  <Text style={styles.roundHoleMeta}>{item.par !== undefined ? `PAR ${item.par} · ` : ''}{countStrokes(item.shots)} {countStrokes(item.shots) === 1 ? 'STROKE' : 'STROKES'}{item.par !== undefined ? ` (${formatScoreToPar(countStrokes(item.shots) - item.par)})` : ''}</Text>
                </Pressable>
                {expandedHole === item.hole && renderRoundHoleMap(item.hole, item.shots)}
                {item.shots.map((shot, index) => <Text key={index} style={styles.roundThrow}>{index + 1}.  {formatThrowDetail(shot)}</Text>)}
              </View>)}
              {showingRoundSummary && <Pressable onPress={() => setScreen('Home')} style={styles.finishButton}><Text style={styles.finishButtonText}>DONE</Text></Pressable>}
            </>}
          </ScrollView>
        ) : screen === 'Insights' ? (
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.insightHero}>
              <Text style={styles.insightEyebrow}>{history.length ? 'SESSION HISTORY' : 'THIS SESSION'}</Text>
              <Text style={styles.insightNumber}>{averageFeet}<Text style={styles.insightUnit}> ft</Text></Text>
              <Text style={styles.insightCaption}>average throw distance</Text>
              <View style={styles.sparkline}>
                {recentShots.map((shot, index) => (
                  <View key={`${shot.hole}-${index}`} style={[styles.sparkBar, { height: Math.max(12, Math.round((shot.feet / longestRecentThrow) * 85)) }]} />
                ))}
              </View>
              <View style={styles.sparkLabels}>
                <Text style={styles.insightCaption}>{recentShots.length ? `THROW ${String(shots.length - recentShots.length + 1).padStart(2, '0')}` : 'NO THROWS YET'}</Text>
                <Text style={styles.insightCaption}>{recentShots.length ? `THROW ${String(shots.length).padStart(2, '0')}` : 'LOG A THROW TO BEGIN'}</Text>
              </View>
            </View>
            <View style={styles.statsGrid}><View style={styles.statBlock}><Text style={styles.statLabel}>LOGGED THROWS</Text><Text style={styles.statValue}>{allShots.length}</Text></View><View style={styles.statBlock}><Text style={styles.statLabel}>TOTAL DISTANCE</Text><Text style={styles.statValue}>{totalFeet} ft</Text></View></View>
            <Text style={styles.sectionTitle}>By disc</Text>
            {bag.map((item, index) => { const used = allShots.filter((shot) => shot.disc === item); const avg = used.length ? Math.round(used.reduce((sum, shot) => sum + shot.feet, 0) / used.length) : 0; return <View key={`${item}-${index}`} style={styles.discStat}><Text style={styles.discStatName}>{item}</Text><View style={styles.discStatTrack}><View style={[styles.discStatFill, { width: `${Math.min(100, avg / 3)}%` }]} /></View><Text style={styles.discStatValue}>{used.length ? `${avg} ft` : '—'}</Text></View>; })}
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
                  {bag.map((item, index) => <Pressable key={`${item}-${index}`} onPress={() => { setDisc(item); setLogStep(2); }} style={[styles.chip, styles.sheetChip, disc === item && styles.chipSelected]}><Text style={[styles.chipText, disc === item && styles.chipTextSelected]}>{item}</Text></Pressable>)}
                  {!bag.length && <Pressable onPress={() => { setDisc(''); setLogStep(2); }} style={[styles.chip, styles.sheetChip]}><Text style={styles.chipText}>No disc (bag is empty)</Text></Pressable>}
                </View>
              </> : logStep === 2 ? <>
                <Text style={styles.fieldLabel}>TYPE OF THROW</Text>
                <View style={styles.typeRow}>
                  {TYPE_OPTIONS.map((item) => <Pressable key={item} onPress={() => { setThrowType(item); setLogStep(3); }} style={[styles.typeButton, styles.sheetTypeButton, throwType === item && styles.typeButtonSelected]}><Text style={[styles.typeText, throwType === item && styles.typeTextSelected]}>{item}</Text></Pressable>)}
                </View>
              </> : logStep === 3 ? <>
                <Text style={styles.fieldLabel}>WHERE DID IT LAND?</Text>
                <View style={[styles.typeRow, styles.lieGrid]}>
                  {LIE_OPTIONS.map((item) => <Pressable key={item} onPress={() => { if (item === 'Basket') { saveThrow(QUALITY_MAX, 'Basket'); return; } setThrowLie(item); setLogStep(4); }} style={[styles.typeButton, styles.sheetTypeButton, styles.lieButton, item === 'OB' && styles.obButton, throwLie === item && styles.typeButtonSelected]} accessibilityLabel={item === 'OB' ? 'Out of bounds, one penalty stroke' : item}><Text style={[styles.typeText, item === 'OB' && styles.obText, throwLie === item && styles.typeTextSelected]}>{item}</Text>{item === 'OB' && <Text style={styles.obPenaltyText}>+1 STROKE</Text>}</Pressable>)}
                </View>
              </> : <>
                <Text style={styles.fieldLabel}>HOW WAS THE THROW?</Text>
                <View style={styles.typeRow}>
                  {QUALITY_OPTIONS.map((option) => <Pressable key={option.value} onPress={() => saveThrow(option.value)} style={[styles.typeButton, styles.qualityButton]} accessibilityLabel={`Quality ${option.value}, ${option.label}`}><Text style={styles.qualityValue}>{option.value}</Text><Text style={styles.qualityLabel}>{option.label}</Text></Pressable>)}
                </View>
              </>}
              <View style={styles.sheetFooter}>
                <Pressable onPress={cancelLogThrow} style={styles.sheetFooterButton}><Text style={styles.undoText}>CANCEL</Text></Pressable>
                {logStep > 1 && <Pressable onPress={() => setLogStep(logStep === 4 ? 3 : logStep === 3 ? 2 : 1)} style={styles.sheetFooterButton}><Text style={styles.undoText}>‹ BACK</Text></Pressable>}
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
  screen: { flex: 1, backgroundColor: '#e8e9df', alignItems: 'center' },
  appFrame: { flex: 1, width: '100%', maxWidth: 560, backgroundColor: PAPER, paddingTop: 48 },
  appFrameCompact: { paddingTop: 38 },
  topline: { height: 46, marginHorizontal: 23, flexDirection: 'row', alignItems: 'center' },
  brandMark: { width: 34, height: 34, borderRadius: 11, backgroundColor: GREEN, alignItems: 'center', justifyContent: 'center' },
  brandGlyph: { color: '#fff', fontFamily: 'Georgia', fontSize: 22, fontWeight: '700' },
  brand: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  brandCopy: { marginLeft: 10, flex: 1 },
  brandName: { color: INK, fontSize: 12, fontWeight: '800', letterSpacing: 1.25 },
  brandSub: { color: MUTED, fontSize: 8, fontWeight: '700', marginTop: 3 },
  avatar: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: '#d5d7cd', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: INK, fontSize: 10, fontWeight: '800' },
  avatarSignedIn: { backgroundColor: GREEN, borderColor: GREEN },
  avatarTextSignedIn: { color: '#fff' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, marginBottom: 10, padding: 12, borderRadius: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e5e5dc' },
  toggleCopy: { flex: 1, marginRight: 12 },
  toggleAction: { alignSelf: 'flex-start', marginTop: 0, marginBottom: 16 },
  authTabs: { marginTop: 0, marginBottom: 12 },
  authError: { color: '#a55343', fontSize: 10, lineHeight: 15, marginTop: 10 },
  accountStatus: { color: INK, fontFamily: 'Georgia', fontSize: 17, marginTop: 6, marginBottom: 4 },
  serverNote: { color: '#a5aa9c', fontSize: 7, fontWeight: '700', letterSpacing: 0.6, marginTop: 24, textAlign: 'center' },
  backLink: { alignSelf: 'flex-start', paddingVertical: 6, marginBottom: 8 },
  pageHeading: { marginHorizontal: 23, marginTop: 28, marginBottom: 19, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  eyebrow: { color: GREEN, fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: INK, fontFamily: 'Georgia', fontSize: 30, marginTop: 5 },
  weather: { flexDirection: 'row', alignItems: 'center', marginBottom: 5 },
  weatherIcon: { fontSize: 14, color: '#d38244', marginRight: 4 },
  weatherText: { color: MUTED, fontSize: 8, fontWeight: '800' },
  homeButton: { borderWidth: 1, borderColor: '#d9dbd0', paddingHorizontal: 11, paddingVertical: 8, borderRadius: 6 },
  homeButtonText: { color: GREEN, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  content: { paddingHorizontal: 23, paddingTop: 15, paddingBottom: 20 },
  menuIntro: { backgroundColor: '#e9eee5', borderRadius: 9, padding: 18, marginTop: 1, marginBottom: 17 },
  menuIntroLabel: { color: GREEN, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  menuIntroTitle: { color: INK, fontFamily: 'Georgia', fontSize: 21, marginTop: 8 },
  menuIntroCopy: { color: MUTED, fontSize: 10, marginTop: 5 },
  menuOptions: { borderTopWidth: 1, borderTopColor: '#dedfd5' },
  menuItem: { minHeight: 76, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#dedfd5', paddingHorizontal: 5 },
  resumeItem: { marginTop: 0, marginBottom: 14 },
  menuItemPrimary: { backgroundColor: GREEN, borderBottomColor: GREEN, paddingHorizontal: 12, marginTop: 9, borderRadius: 7 },
  menuNumber: { color: '#a5aa9c', fontSize: 10, fontWeight: '800', width: 37 },
  menuNumberPrimary: { color: '#bcd2c0' },
  menuItemCopy: { flex: 1 },
  menuTitle: { color: INK, fontFamily: 'Georgia', fontSize: 17 },
  menuTitlePrimary: { color: '#fff' },
  menuSubtitle: { color: MUTED, fontSize: 9, marginTop: 4 },
  menuSubtitlePrimary: { color: '#d2e1d5' },
  menuArrow: { color: GREEN, fontSize: 24, paddingHorizontal: 8 },
  menuArrowPrimary: { color: '#fff' },
  builderPanel: { backgroundColor: '#fff', padding: 16, borderRadius: 8, borderWidth: 1, borderColor: '#e5e5dc', marginBottom: 24 },
  builderLabel: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
  detailLabel: { marginTop: 14 },
  cityStateRow: { flexDirection: 'row' },
  courseStatsGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4, marginBottom: 14 },
  courseStat: { width: '50%', paddingVertical: 10, paddingRight: 10 },
  courseStatValue: { color: INK, fontFamily: 'Georgia', fontSize: 21, marginTop: 4 },
  courseStatNote: { color: MUTED, fontSize: 8, marginTop: 3 },
  roundCourseInfo: { marginTop: 18, padding: 14, borderRadius: 9, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e8e7de' },
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
  builderInput: { height: 43, borderBottomWidth: 1, borderBottomColor: '#dfe1d7', color: INK, fontSize: 13, paddingHorizontal: 2, marginTop: 5 },
  primaryButton: { minHeight: 46, borderRadius: 7, backgroundColor: GREEN, alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  disabledButton: { opacity: 0.5 },
  primaryButtonText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  builderSectionTitle: { color: INK, fontFamily: 'Georgia', fontSize: 18, marginBottom: 7 },
  courseItem: { minHeight: 62, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#dedfd5', paddingHorizontal: 7 },
  courseItemSelected: { backgroundColor: '#edf0e8' },
  courseItemSelect: { flex: 1, minHeight: 61, flexDirection: 'row', alignItems: 'center' },
  courseItemCopy: { flex: 1 },
  courseItemName: { color: INK, fontSize: 12, fontWeight: '700' },
  courseItemMeta: { color: MUTED, fontSize: 9, marginTop: 4 },
  courseSelectedMark: { color: GREEN, fontSize: 16, paddingHorizontal: 8 },
  deleteButton: { minHeight: 36, minWidth: 54, alignItems: 'center', justifyContent: 'center', marginLeft: 6 },
  deleteButtonText: { color: '#a55343', fontSize: 8, fontWeight: '800', letterSpacing: 0.4 },
  deleteHoleButton: { minHeight: 34, alignSelf: 'flex-end', justifyContent: 'center', paddingHorizontal: 8, marginTop: 6 },
  mapEditor: { marginTop: 24, paddingTop: 18, borderTopWidth: 1, borderTopColor: '#dedfd5' },
  mapEditorHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  mapProgress: { color: GREEN, fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },
  editorHoleNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  holeNavButton: { width: 38, height: 36, borderWidth: 1, borderColor: '#dfe1d7', borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  holeNavDisabled: { opacity: 0.35 },
  holeNavArrow: { color: GREEN, fontSize: 22, lineHeight: 25 },
  editorHoleCopy: { alignItems: 'center' },
  editorHoleName: { color: INK, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  editorHoleStatus: { color: MUTED, fontSize: 8, marginTop: 4 },
  markerTargetRow: { flexDirection: 'row', marginTop: 13, backgroundColor: '#eaeae1', borderRadius: 7, padding: 3 },
  markerTarget: { flex: 1, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 5 },
  markerTargetActive: { backgroundColor: '#fff' },
  markerTargetText: { color: MUTED, fontSize: 9, fontWeight: '700' },
  markerTargetTextActive: { color: GREEN, fontWeight: '800' },
  mapInstruction: { color: MUTED, fontSize: 9, marginTop: 10 },
  gpsPointCard: { padding: 12, marginTop: 9, borderWidth: 1, borderColor: '#e1e2d8', borderRadius: 7, backgroundColor: '#fff' },
  gpsPointHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  gpsPointLabel: { color: INK, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  gpsPointState: { color: '#aa6a3f', fontSize: 7, fontWeight: '800', letterSpacing: 0.4 },
  gpsPointSaved: { color: GREEN },
  gpsCoordinates: { color: INK, fontSize: 12, fontVariant: ['tabular-nums'], marginTop: 7 },
  gpsAccuracy: { color: MUTED, fontSize: 8, marginTop: 4 },
  holeDistance: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 10, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 7, backgroundColor: '#e9eee5' },
  parPicker: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 },
  parOptions: { flexDirection: 'row' },
  parOption: { width: 40, height: 36, marginLeft: 6, borderRadius: 6, borderWidth: 1, borderColor: '#dedfd5', alignItems: 'center', justifyContent: 'center' },
  parOptionSelected: { backgroundColor: GREEN, borderColor: GREEN },
  parOptionText: { color: INK, fontFamily: 'Georgia', fontSize: 16 },
  parOptionTextSelected: { color: '#fff' },
  holeDistanceLabel: { color: GREEN, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  holeDistanceValue: { color: INK, fontFamily: 'Georgia', fontSize: 20, fontVariant: ['tabular-nums'] },
  gpsMessage: { color: GREEN, fontSize: 9, lineHeight: 14, marginTop: 10 },
  holeWizard: { flex: 1, paddingHorizontal: 23, paddingBottom: 14 },
  wizardProgress: { height: 38, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  wizardMappedCount: { marginTop: 4 },
  satelliteFrame: { flex: 1, minHeight: 230, marginTop: 6, borderRadius: 8, overflow: 'hidden', backgroundColor: '#dce6d5', position: 'relative' },
  satelliteMap: { ...StyleSheet.absoluteFill },
  satelliteBadge: { position: 'absolute', top: 11, left: 11, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 5, backgroundColor: 'rgba(24,35,31,0.82)' },
  satelliteBadgeText: { color: '#fff', fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  recenterButton: { position: 'absolute', top: 10, right: 10, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 5, backgroundColor: '#fff' },
  recenterButtonText: { color: INK, fontSize: 8, fontWeight: '800' },
  mapScaleBadge: { position: 'absolute', left: 11, bottom: 11, minWidth: 120, paddingHorizontal: 9, paddingVertical: 8, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.92)' },
  mapScaleRule: { height: 4, maxWidth: '100%', borderBottomWidth: 2, borderLeftWidth: 1, borderRightWidth: 1, borderColor: INK, marginBottom: 4 },
  mapScaleLabel: { color: INK, fontSize: 8, fontWeight: '800' },
  mapScaleWidth: { color: MUTED, fontSize: 7, fontWeight: '700', marginTop: 2 },
  mapUnavailable: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#e9eee5' },
  mapUnavailableTitle: { color: INK, fontFamily: 'Georgia', fontSize: 17, textAlign: 'center' },
  mapUnavailableText: { color: MUTED, fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: 8 },
  captureButtons: { flexDirection: 'row', marginTop: 10 },
  captureButton: { flex: 1, minHeight: 78, paddingHorizontal: 9, paddingVertical: 10, borderRadius: 7, borderWidth: 1, borderColor: '#dfe1d7', backgroundColor: '#fff', marginRight: 8 },
  captureButtonSaved: { borderColor: GREEN, backgroundColor: '#edf2e9' },
  captureButtonLabel: { color: INK, fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  captureButtonValue: { color: GREEN, fontSize: 8, fontWeight: '800', marginTop: 5 },
  captureButtonCoords: { color: MUTED, fontSize: 8, marginTop: 5, fontVariant: ['tabular-nums'] },
  wizardNavigation: { flexDirection: 'row', marginTop: 9 },
  wizardNavButton: { flex: 1, minHeight: 42, borderWidth: 1, borderColor: '#dfe1d7', borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginRight: 7 },
  wizardNavNext: { backgroundColor: GREEN, borderColor: GREEN, marginRight: 0, marginLeft: 7 },
  wizardNavText: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.4 },
  wizardNavNextText: { color: '#fff' },
  wizardNavFinish: { marginRight: 0, borderColor: GREEN },
  wizardNavFinishText: { color: GREEN, fontSize: 8, fontWeight: '800', letterSpacing: 0.4 },
  builderHint: { color: MUTED, fontSize: 9, marginTop: 8 },
  parEditorHeading: { marginTop: 22 },
  parRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#e1e2d8' },
  parStepButton: { width: 36, height: 36, borderRadius: 6, borderWidth: 1, borderColor: '#dedfd5', alignItems: 'center', justifyContent: 'center' },
  parStepText: { color: GREEN, fontSize: 18, fontWeight: '600' },
  parStepValue: { width: 38, textAlign: 'center', color: INK, fontFamily: 'Georgia', fontSize: 18 },
  addHoleButton: { height: 42, marginTop: 12, borderRadius: 6, borderWidth: 1, borderColor: GREEN, alignItems: 'center', justifyContent: 'center' },
  addHoleButtonText: { color: GREEN, fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  roundTotals: { flexDirection: 'row', marginTop: -8, marginBottom: 18, paddingHorizontal: 4 },
  roundTotal: { flex: 1 },
  roundTotalValue: { color: INK, fontFamily: 'Georgia', fontSize: 19, marginTop: 3 },
  secondaryStart: { marginTop: 19, minHeight: 44, borderWidth: 1, borderColor: GREEN, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  secondaryStartText: { color: GREEN, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  builderFootnote: { color: '#899083', fontSize: 9, lineHeight: 14, marginTop: 11 },
  addDiscRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  discInput: { flex: 1, marginRight: 12 },
  discResults: { marginTop: 10, borderTopWidth: 1, borderTopColor: '#e1e2d8' },
  discResult: { minHeight: 52, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#e1e2d8' },
  discResultCopy: { flex: 1, marginRight: 8 },
  discResultFlight: { color: INK, fontSize: 10, fontWeight: '700', fontVariant: ['tabular-nums'] },
  discResultsNote: { color: MUTED, fontSize: 10, lineHeight: 15, paddingVertical: 10 },
  discResultsCredit: { color: MUTED, fontSize: 7, fontWeight: '700', letterSpacing: 0.5, marginTop: 8 },
  addDiscButton: { height: 34, minWidth: 56, paddingHorizontal: 13, backgroundColor: GREEN, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  addDiscButtonText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  practiceIntro: { backgroundColor: '#e9eee5', borderRadius: 9, padding: 18, marginBottom: 17 },
  practiceIntroTitle: { color: INK, fontFamily: 'Georgia', fontSize: 20, marginTop: 9 },
  practiceIntroCopy: { color: MUTED, fontSize: 10, lineHeight: 15, marginTop: 6 },
  practiceChoice: { minHeight: 67, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#dedfd5', paddingHorizontal: 8 },
  practiceChoiceSelected: { backgroundColor: '#edf0e8' },
  practiceChoiceCopy: { flex: 1 },
  practiceChoiceTitle: { color: INK, fontFamily: 'Georgia', fontSize: 16 },
  practiceChoiceSubtitle: { color: MUTED, fontSize: 9, marginTop: 4 },
  practiceChoiceMark: { color: GREEN, fontSize: 16, paddingHorizontal: 9 },
  courseLabel: { flex: 1, paddingRight: 10 },
  courseLabelName: { color: INK, fontSize: 12, fontWeight: '700', marginTop: 4 },
  roundToolbar: { height: 45, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modeSwitch: { flexDirection: 'row', backgroundColor: '#eaeae1', borderRadius: 8, padding: 3 },
  modeOption: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 6 },
  modeSelected: { backgroundColor: '#fff' },
  modeText: { color: MUTED, fontSize: 10, fontWeight: '700' },
  modeTextSelected: { color: INK },
  holeSelector: { alignItems: 'center' },
  roundHoleNav: { flexDirection: 'row', alignItems: 'center' },
  roundHoleArrow: { width: 34, height: 40, borderWidth: 1, borderColor: '#dedfd5', borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginHorizontal: 8 },
  holeLabel: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  holeNumber: { color: INK, fontFamily: 'Georgia', fontSize: 20 },
  holeTotal: { color: MUTED, fontFamily: 'Arial', fontSize: 11 },
  chevron: { color: GREEN, fontFamily: 'Arial', fontSize: 12 },
  scoreRow: { height: 82, backgroundColor: '#e9eee5', borderRadius: 10, marginTop: 11, marginBottom: 18, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center' },
  scoreLabel: { color: MUTED, fontSize: 8, letterSpacing: 1, fontWeight: '800' },
  scoreValue: { color: INK, fontFamily: 'Georgia', fontSize: 25, marginTop: 3 },
  scoreUnit: { color: MUTED, fontFamily: 'Arial', fontSize: 12 },
  scoreDivider: { height: 39, width: 1, backgroundColor: '#cfd7ca', marginHorizontal: 22 },
  parPill: { marginLeft: 'auto', backgroundColor: '#d8e5d5', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 20 },
  parText: { color: GREEN, fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },
  sectionTitleRow: { height: 27, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { color: INK, fontFamily: 'Georgia', fontSize: 18 },
  mapHint: { flexDirection: 'row', alignItems: 'center' },
  mapHintDot: { width: 6, height: 6, backgroundColor: '#df894c', borderRadius: 3, marginRight: 5 },
  mapHintText: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },
  roundMapFrame: { height: 300, marginTop: 8, marginBottom: 17, borderRadius: 9, overflow: 'hidden', backgroundColor: '#dce6d5', position: 'relative' },
  shotMarker: { width: 22, height: 22, borderRadius: 12, borderWidth: 2, borderColor: '#fff', backgroundColor: '#df8547', alignItems: 'center', justifyContent: 'center' },
  shotPinText: { color: '#fff', fontSize: 9, fontWeight: '900' },
  boardCaption: { position: 'absolute', bottom: 11, left: 12, right: 12, flexDirection: 'row', justifyContent: 'space-between' },
  boardCaptionText: { color: '#667b60', fontSize: 7, fontWeight: '800', letterSpacing: 0.7 },
  boardScale: { color: '#7c8e75', fontSize: 7, fontWeight: '700' },
  roundHoleDistance: { marginTop: -5, marginBottom: 15 },
  logThrowButton: { minHeight: 64, backgroundColor: '#df8547', borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingVertical: 10 },
  logThrowButtonText: { color: '#fff', fontSize: 13, fontWeight: '900', letterSpacing: 1.2 },
  logThrowButtonHint: { color: '#fdeee2', fontSize: 9, marginTop: 4 },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(24,35,31,0.45)' },
  sheet: { backgroundColor: PAPER, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, paddingBottom: 34, width: '100%', maxWidth: 560, alignSelf: 'center' },
  sheetDistance: { color: GREEN, fontSize: 11, fontWeight: '700', marginTop: -4, marginBottom: 16 },
  sheetOptions: { flexDirection: 'row', flexWrap: 'wrap', paddingTop: 9 },
  sheetChip: { height: 40, marginBottom: 8, paddingHorizontal: 14 },
  sheetTypeButton: { height: 46 },
  lieGrid: { flexWrap: 'wrap', marginRight: -7 },
  lieButton: { flex: 0, width: '31%', marginBottom: 7 },
  obButton: { borderColor: '#e2b3a6' },
  obText: { color: '#a55343' },
  obPenaltyText: { color: '#a55343', fontSize: 7, fontWeight: '800', marginTop: 2 },
  qualityButton: { height: 58 },
  qualityValue: { color: INK, fontFamily: 'Georgia', fontSize: 19 },
  qualityLabel: { color: MUTED, fontSize: 8, fontWeight: '700', marginTop: 2 },
  sheetFooter: { flexDirection: 'row-reverse', justifyContent: 'space-between', marginTop: 18 },
  sheetFooterButton: { borderWidth: 1, borderColor: '#dedfd5', borderRadius: 5, paddingHorizontal: 14, paddingVertical: 10 },
  controlHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  controlTitle: { color: INK, fontFamily: 'Georgia', fontSize: 17 },
  controlStep: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
  fieldLabel: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.9 },
  chipRow: { flexDirection: 'row', paddingTop: 7, paddingBottom: 2 },
  chip: { paddingHorizontal: 12, height: 30, borderRadius: 6, borderWidth: 1, borderColor: '#e2e4da', marginRight: 7, justifyContent: 'center' },
  chipSelected: { backgroundColor: GREEN, borderColor: GREEN },
  chipText: { color: '#5d685e', fontSize: 10, fontWeight: '700' },
  chipTextSelected: { color: '#fff' },
  typeLabel: { marginTop: 9 },
  typeRow: { flexDirection: 'row', marginTop: 7 },
  typeButton: { flex: 1, height: 31, borderRadius: 6, borderWidth: 1, borderColor: '#e2e4da', alignItems: 'center', justifyContent: 'center', marginRight: 7 },
  typeButtonSelected: { backgroundColor: '#f2e6d9', borderColor: '#e7c9ad' },
  typeText: { color: '#697169', fontSize: 10, fontWeight: '700' },
  typeTextSelected: { color: '#98572f' },
  latestRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#e2e3d9' },
  latestEyebrow: { color: MUTED, fontSize: 7, fontWeight: '800', letterSpacing: 0.8 },
  latestText: { color: INK, fontSize: 11, fontWeight: '600', marginTop: 4 },
  undoButton: { borderWidth: 1, borderColor: '#dedfd5', borderRadius: 5, paddingHorizontal: 10, paddingVertical: 7 },
  undoText: { color: MUTED, fontSize: 8, fontWeight: '800' },
  finishButton: { height: 46, backgroundColor: GREEN, borderRadius: 7, marginTop: 12, alignItems: 'center', justifyContent: 'center' },
  endSessionButton: { height: 42, borderRadius: 7, borderWidth: 1, borderColor: '#dedfd5', marginTop: 8, alignItems: 'center', justifyContent: 'center' },
  endSessionText: { color: '#a55343', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  finishButtonText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  finishArrow: { fontSize: 14 },
  footnote: { textAlign: 'center', color: '#899083', fontSize: 8, marginTop: 10, marginBottom: 2 },
  bottomBar: { height: 36, borderTopWidth: 1, borderTopColor: '#e1e2d8', paddingHorizontal: 23, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bottomStatus: { color: MUTED, fontSize: 7, fontWeight: '800', letterSpacing: 0.7 },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#6f9a68', marginRight: 5 },
  bottomCount: { color: MUTED, fontSize: 7, fontWeight: '800' },
  insightHero: { marginTop: 6, padding: 20, backgroundColor: '#e9eee5', borderRadius: 9 },
  insightEyebrow: { color: GREEN, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  insightNumber: { color: INK, fontFamily: 'Georgia', fontSize: 48, marginTop: 10 },
  insightUnit: { color: MUTED, fontFamily: 'Arial', fontSize: 16 },
  insightCaption: { color: MUTED, fontSize: 9, fontWeight: '600' },
  sparkline: { height: 105, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 13, paddingHorizontal: 4 },
  sparkBar: { width: '10%', backgroundColor: '#6b9b73', borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  sparkLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  finalScore: { backgroundColor: '#e9eee5', borderRadius: 9, padding: 18, marginTop: 1, marginBottom: 20 },
  finalScoreRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 6 },
  finalScoreValue: { color: INK, fontFamily: 'Georgia', fontSize: 44 },
  finalScoreToPar: { color: INK, fontFamily: 'Georgia', fontSize: 26, marginLeft: 12 },
  underPar: { color: GREEN },
  overPar: { color: '#c0682f' },
  resultChips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 },
  resultChip: { backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5, marginRight: 6, marginBottom: 6 },
  resultChipText: { color: INK, fontSize: 9, fontWeight: '700' },
  scorecard: { marginTop: 8, marginBottom: 22, borderRadius: 9, borderWidth: 1, borderColor: '#e1e2d8', backgroundColor: '#fff', overflow: 'hidden' },
  scorecardRow: { flexDirection: 'row', alignItems: 'center', minHeight: 38, borderBottomWidth: 1, borderBottomColor: '#eeeee6' },
  scorecardHeader: { minHeight: 32, backgroundColor: '#f1f1ea' },
  scorecardTotal: { borderBottomWidth: 0, backgroundColor: '#f1f1ea' },
  scorecardCell: { flex: 1, textAlign: 'center', color: INK, fontSize: 12, fontVariant: ['tabular-nums'] },
  scorecardHoleCell: { textAlign: 'left', paddingLeft: 14 },
  scorecardHeaderText: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  scorecardScore: { fontWeight: '800' },
  throwByThrowTitle: { marginBottom: 4 },
  sessionModeTag: { color: GREEN, fontSize: 7, fontWeight: '800', letterSpacing: 0.6, marginRight: 8 },
  roundHole: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#e1e2d8' },
  roundHoleHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 },
  roundHoleMapToggle: { color: GREEN, fontFamily: 'Arial', fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  roundHoleMap: { height: 260, marginTop: 4, marginBottom: 10, borderRadius: 9, overflow: 'hidden', backgroundColor: '#dce6d5' },
  scorecardRowActive: { backgroundColor: '#e9eee5' },
  obMarker: { backgroundColor: '#a55343' },
  roundHoleTitle: { color: INK, fontFamily: 'Georgia', fontSize: 16 },
  roundHoleMeta: { color: GREEN, fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  roundThrow: { color: MUTED, fontSize: 10, lineHeight: 17 },
  statsGrid: { flexDirection: 'row', marginTop: 12, marginBottom: 25 },
  statBlock: { flex: 1, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: '#dedfd5' },
  statLabel: { color: MUTED, fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  statValue: { color: INK, fontFamily: 'Georgia', fontSize: 23, marginTop: 7 },
  discStat: { flexDirection: 'row', alignItems: 'center', height: 48, borderBottomWidth: 1, borderBottomColor: '#e3e3da' },
  discStatName: { width: 82, color: INK, fontSize: 10, fontWeight: '700' },
  discStatTrack: { flex: 1, height: 5, backgroundColor: '#e3e5dc', borderRadius: 4, overflow: 'hidden' },
  discStatFill: { height: 5, backgroundColor: '#6c9a72', borderRadius: 4 },
  discStatValue: { width: 51, textAlign: 'right', color: MUTED, fontSize: 9, fontWeight: '700' },
  bagIntro: { backgroundColor: '#e9eee5', padding: 20, borderRadius: 9, marginTop: 6, marginBottom: 15 },
  bagHeadline: { color: INK, fontFamily: 'Georgia', fontSize: 28, marginTop: 10 },
  bagBody: { color: MUTED, fontSize: 11, lineHeight: 17, marginTop: 6 },
  bagItem: { minHeight: 67, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#e1e2d8', paddingHorizontal: 4 },
  bagItemSelect: { flex: 1, minHeight: 66, flexDirection: 'row', alignItems: 'center' },
  bagItemSelected: { backgroundColor: '#eeefe7' },
  discSwatch: { width: 39, height: 39, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  discSwatchText: { color: '#fff', fontSize: 12, fontWeight: '900' },
  bagItemCopy: { marginLeft: 12, flex: 1 },
  bagItemName: { color: INK, fontSize: 12, fontWeight: '800' },
  bagItemMeta: { color: MUTED, fontSize: 9, marginTop: 4 },
  bagArrow: { color: GREEN, fontSize: 17, paddingHorizontal: 9 },
});
