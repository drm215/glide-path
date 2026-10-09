// The app's shared state: what's stored on the phone, the round in progress, and the account and
// sync. Screens read it with useApp(); state only one screen needs lives in that screen, and which
// screen is showing (and its parameters) lives in the route.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type SetStateAction } from 'react';
import { Alert, AppState } from 'react-native';
import { ApiError, syncWithServer, type PublicCourse } from '../../lib/api';
import { MAIN_LAYOUT_ID, courseLayouts, layoutDisplayName, updateLayoutIn, withExistingLayout, withLayout, type CourseView } from '../../lib/layouts';
import { placeMadeThrowsAtBasket } from '../../lib/rounds';
import { buildSyncRequest, clearSentTombstones, countPendingChanges, initialBagUpdatedAt, mergeCourses, mergeRounds, sendInBatches, type SyncAccount, type SyncData } from '../../lib/sync';
import type { Course, CourseDetails, CourseLayout, Disc, DiscInfo, HoleLayout, SessionArchive, Shot, ThrowStyle, Tombstone } from '../../lib/types';
import { ACTIVE_SESSION_ID, LEGACY_DEFAULT_DISCS, SYNC_DEBOUNCE_MS } from '../constants';
import { errorMessage, formatSessionDate } from '../format';
import { isGpsPoint } from '../geo';
import { backTo, go, openHoleMapping, openRound } from '../navigation';
import {
  BAG_DETAILS_KEY, BAG_KEY, BAG_WEIGHTS_KEY, COURSES_KEY, HISTORY_KEY, LAST_ACCOUNT_KEY, MIGRATIONS_KEY, SETTINGS_KEY, STORAGE_KEY,
  SYNC_KEY, SYNC_META_KEY, TOKEN_KEY, saveToStorage, unsaveableKeys, type LastAccount, type ResumedFrom, type SavedRound, type Settings, type ThrowDetails,
} from '../storage';
import { newSessionId, nowMs } from '../time';

export type SessionMode = 'Round' | 'Practice';

const useAppState = () => {
  const [mode, setMode] = useState<SessionMode>('Round');
  const [hole, setHole] = useState(4);
  const [shots, setShotsState] = useState<Shot[]>([]);
  // The round in progress: its id (given when it starts, so its in-progress upload and finished
  // record are one round) and when its throws last changed, which makes it sync.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeEditedAt, setActiveEditedAt] = useState(0);
  // Changes to the round's throws go through here so it uploads while in progress.
  const setShots = (update: SetStateAction<Shot[]>) => {
    setShotsState(update);
    setActiveEditedAt(nowMs());
  };
  const [history, setHistory] = useState<SessionArchive[]>([]);
  const [disc, setDisc] = useState<Disc>('');
  const [bag, setBag] = useState<Disc[]>([]);
  const [bagDetails, setBagDetails] = useState<Record<Disc, DiscInfo>>({});
  // Disc weights in grams, keyed by disc name.
  const [bagWeights, setBagWeights] = useState<Record<Disc, number>>({});
  const [courses, setCourses] = useState<Course[]>([{ id: 'pine-ridge', name: 'Pine Ridge (Sample)', holes: 18, layouts: Array.from({ length: 18 }, () => ({ tee: null, basket: null })) }]);
  const [selectedCourseId, setSelectedCourseId] = useState('pine-ridge');
  const [selectedLayoutId, setSelectedLayoutId] = useState(MAIN_LAYOUT_ID);
  const [locationAllowed, setLocationAllowed] = useState(false);
  const [practiceFocus, setPracticeFocus] = useState('Distance');
  const [sessionActive, setSessionActive] = useState(false);
  const [resumedFrom, setResumedFrom] = useState<ResumedFrom | null>(null);
  // A throw whose details are entered, waiting below the map for its location; saved with the
  // round so it survives leaving the round screen or closing the app.
  const [pendingThrow, setPendingThrow] = useState<ThrowDetails | null>(null);
  // Shown on the round screen, e.g. after resuming a round from its summary.
  const [roundMessage, setRoundMessage] = useState('');
  // The last style used is the default for the next throw.
  const [throwStyle, setThrowStyle] = useState<ThrowStyle>('Backhand');
  // Whether the round screen lowers brightness to save battery; players turn it off in bright sun.
  const [dimRound, setDimRound] = useState(true);
  // New-course flow: 1 name, 2 details, 3 layouts, 4 map holes. The course is created after step 1.
  // It lives here because the flow hands off to hole mapping and picks up where it left off.
  const [newCourseStep, setNewCourseStep] = useState<1 | 2 | 3 | 4>(1);
  const [newCourseId, setNewCourseId] = useState<string | null>(null);
  const [courseName, setCourseName] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [account, setAccount] = useState<SyncAccount | null>(null);
  const lastAccount = useRef<LastAccount | null>(null);
  const [bagUpdatedAt, setBagUpdatedAt] = useState(0);
  const [deletedCourses, setDeletedCourses] = useState<Tombstone[]>([]);
  const [deletedRounds, setDeletedRounds] = useState<Tombstone[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const syncInFlight = useRef(false);

  const selectedBaseCourse = courses.find((course) => course.id === selectedCourseId) ?? courses[0];
  // Most screens work on the selected layout of the selected course.
  const selectedCourse: CourseView | undefined = selectedBaseCourse ? withLayout(selectedBaseCourse, selectedLayoutId) : undefined;
  const selectedCourseLayouts = selectedBaseCourse ? courseLayouts(selectedBaseCourse) : [];
  const hasMultipleLayouts = selectedCourseLayouts.length > 1;

  useEffect(() => {
    // Each stored value is read on its own, so one that can't be read doesn't stop the rest from
    // loading. The app will save over it, so its raw text is first copied to a backup key.
    const load = async () => {
      const keys = [STORAGE_KEY, HISTORY_KEY, COURSES_KEY, BAG_KEY, BAG_DETAILS_KEY, BAG_WEIGHTS_KEY, SYNC_KEY, SYNC_META_KEY, MIGRATIONS_KEY, LAST_ACCOUNT_KEY, SETTINGS_KEY];
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
        setShotsState(fixMadeThrows ? placeMadeThrowsAtBasket(activeShots, layoutsFor(saved.courseId, saved.layoutId)) : activeShots);
        setHole(saved.hole);
        setMode(saved.mode);
        setSelectedLayoutId(saved.layoutId ?? MAIN_LAYOUT_ID);
        setResumedFrom(saved.resumedFrom ?? null);
        // Rounds saved before `active` existed count as in progress if they have throws.
        setSessionActive(saved.active ?? saved.shots.length > 0);
        setPendingThrow(saved.pendingThrow ?? null);
        // Rounds saved before ids were given at the start get one now (or keep the resumed round's).
        const active = saved.active ?? saved.shots.length > 0;
        setActiveId(saved.activeId ?? saved.resumedFrom?.id ?? (active ? newSessionId() : null));
        setActiveEditedAt(saved.activeEditedAt ?? 0);
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
      read<Settings>(SETTINGS_KEY, (value) => { if (value.dimRound !== undefined) setDimRound(value.dimRound); });
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
    const saved: SavedRound = { shots, hole, mode, courseId: selectedCourseId, active: sessionActive, practiceFocus, layoutId: selectedLayoutId, resumedFrom, pendingThrow, activeId, activeEditedAt };
    saveToStorage(STORAGE_KEY, saved);
  }, [activeEditedAt, activeId, hole, loaded, mode, pendingThrow, practiceFocus, resumedFrom, selectedCourseId, selectedLayoutId, sessionActive, shots]);

  useEffect(() => {
    if (!loaded) return;
    saveToStorage(HISTORY_KEY, history);
  }, [history, loaded]);

  useEffect(() => {
    if (!loaded) return;
    saveToStorage(SETTINGS_KEY, { dimRound } satisfies Settings);
  }, [dimRound, loaded]);

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
  // The session in progress as of the latest render. Alerts keep the callbacks they were created
  // with, so ending a session from one (such as the prompt right after the last hole's made throw)
  // reads these rather than values from before that throw was added.
  const latestSession = useRef({ shots, mode, selectedCourse, resumedFrom, activeId, activeEditedAt });
  useEffect(() => {
    latestSession.current = { shots, mode, selectedCourse, resumedFrom, activeId, activeEditedAt };
  });

  // The round being played, uploaded as in progress once it has a throw.
  const activeRound: SessionArchive | null = sessionActive && activeId && shots.length ? {
    id: activeId, mode, courseName: selectedCourse?.name ?? 'Practice area', courseId: selectedCourse?.id,
    layoutId: selectedCourse?.layoutId, layoutName: selectedCourse?.layoutLabel, shots, updatedAt: activeEditedAt,
    shared: resumedFrom?.shared, shareToken: resumedFrom?.shareToken, inProgress: true,
  } : null;
  const syncData: SyncData = { courses, history, bag, bagDetails, bagWeights, bagUpdatedAt, deletedCourses, deletedRounds, activeRound };
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
        // This device's own round in progress coming back isn't added to its history.
        setHistory((local) => mergeRounds(local, result.rounds, latestSession.current.activeId));
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
  }, [loaded, account, pendingChanges, courses, history, bag, bagDetails, bagWeights, deletedCourses, deletedRounds, activeEditedAt]);

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


  // Moves the current session's throws into history so a new one can begin.
  const archiveSession = () => {
    const { shots, mode, selectedCourse, resumedFrom, activeId, activeEditedAt } = latestSession.current;
    const id = shots.length ? (activeId ?? resumedFrom?.id ?? newSessionId()) : null;
    if (id) {
      const record: SessionArchive = {
        id, mode, courseName: selectedCourse?.name ?? 'Practice area', courseId: selectedCourse?.id,
        layoutId: selectedCourse?.layoutId, layoutName: selectedCourse?.layoutLabel,
        shots, updatedAt: nowMs(), shared: resumedFrom?.shared, shareToken: resumedFrom?.shareToken,
      };
      setHistory((current) => [...current.filter((session) => session.id !== id), record]);
    } else if (activeId && activeEditedAt && latestSync.current.account) {
      // Ended with no throws, but it may have uploaded while it had some: delete that copy.
      setDeletedRounds((current) => [...current, { clientId: activeId, updatedAt: nowMs() }]);
    }
    setShotsState([]);
    setActiveId(null);
    setActiveEditedAt(0);
    setSessionActive(false);
    setResumedFrom(null);
    setPendingThrow(null);
    return id;
  };

  // `onDeleted` runs once the user confirms, e.g. to leave the deleted round's summary.
  const deleteRound = (session: SessionArchive, onDeleted?: () => void) => {
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
            onDeleted?.();
          },
        },
      ],
    );
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
      setResumedFrom({ id: session.id, shared: session.shared, shareToken: session.shareToken });
      setActiveId(session.id);
      setSessionActive(true);
      setRoundMessage(`Resumed on hole ${nextHole}.`);
      go('Round');
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
    const finishedMode = latestSession.current.mode;
    const id = archiveSession();
    if (id && finishedMode === 'Round') {
      openRound(id, true);
      return;
    }
    backTo('Home');
  };

  const beginSession = (nextMode: 'Round' | 'Practice', layoutId?: string, courseId?: string) => {
    archiveSession();
    if (courseId) setSelectedCourseId(courseId);
    if (layoutId) setSelectedLayoutId(layoutId);
    setMode(nextMode);
    setHole(1);
    setRoundMessage('');
    setActiveId(newSessionId());
    setSessionActive(true);
    go('Round');
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

  const selectLayout = (layoutId: string) => {
    const apply = () => {
      setSelectedLayoutId(layoutId);
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

  const updateSessionShots = (sessionId: string, change: (list: Shot[]) => Shot[]) => {
    if (sessionId === ACTIVE_SESSION_ID) {
      setShots(change);
      return;
    }
    const stamp = nowMs();
    setHistory((current) => current.map((session) => (session.id === sessionId ? { ...session, shots: change(session.shots), updatedAt: stamp } : session)));
  };

  const startNewCourse = () => {
    setCourseName('');
    setNewCourseId(null);
    setNewCourseStep(1);
    go('NewCourse');
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
    }
    setNewCourseStep(2);
  };

  // Opens hole mapping for one layout of a course, returning to `from` when finished.
  const mapLayout = (course: Course, layoutId: string, from: 'CourseBuilder' | 'NewCourse') => {
    setSelectedLayoutId(layoutId);
    setSelectedCourseId(course.id);
    openHoleMapping(from);
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
    setShotsState([]);
    setActiveId(null);
    setActiveEditedAt(0);
    setHole(1);
    setDisc('');
    setSessionActive(false);
    setResumedFrom(null);
    setPendingThrow(null);
    setSelectedLayoutId(MAIN_LAYOUT_ID);
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

  const addHoleToCourse = (courseId: string) => {
    updateCourseLayout(courseId, selectedLayoutId, (layout) => ({ ...layout, holes: layout.holes + 1, layouts: [...fullHoleLayouts(layout), { tee: null, basket: null }] }));
  };

  // `onDeleted` lets the hole-mapping screen step back from the deleted hole.
  const deleteHole = (course: Course, holeNumber: number, onDeleted?: () => void) => {
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
              // Holes renumber, so a waiting throw can no longer tell which hole it was on.
              setPendingThrow(null);
              setHole((current) => current === holeNumber ? Math.max(1, holeNumber - 1) : current > holeNumber ? current - 1 : current);
            }
            onDeleted?.();
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
            // The latest courses and throws, not those from when the alert opened: a sync or another
            // edit may have changed them while it was showing.
            const { shots, mode, selectedCourse } = latestSession.current;
            const selectedId = selectedCourse?.id;
            const belongsToCourse = (shot: Shot) => shot.courseId === course.id || (!shot.courseId && selectedId === course.id);
            const courseShots = shots.filter(belongsToCourse);
            if (courseShots.length) {
              setHistory((current) => [...current, { id: newSessionId(), mode, courseName: course.name, courseId: course.id, shots: courseShots, updatedAt: nowMs() }]);
              setShots((current) => current.filter((shot) => !belongsToCourse(shot)));
            }
            const remainingCourses = latestSync.current.data.courses.filter((item) => item.id !== course.id);
            setCourses((current) => current.filter((item) => item.id !== course.id));
            setDeletedCourses((current) => [...current, { clientId: course.id, updatedAt: nowMs() }]);
            if (selectedId === course.id) {
              // A waiting throw belonged to a hole of this course.
              setPendingThrow(null);
              setSelectedCourseId(remainingCourses[0]?.id ?? '');
              setHole(1);
            }
          },
        },
      ],
    );
  };

  // Returns whether the disc was added; a blank or duplicate name isn't.
  const addDisc = (entry: string) => {
    const name = entry.trim();
    if (!name || bag.includes(name)) return false;
    setBag((current) => [...current, name]);
    setBagUpdatedAt(nowMs());
    setDisc(name);
    return true;
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
            // The latest bag, not the one from when the alert opened: a sync or another edit may
            // have changed it while it was showing.
            const remaining = latestSync.current.data.bag.filter((item) => item !== name);
            setBag((current) => current.filter((item) => item !== name));
            setBagUpdatedAt(nowMs());
            setBagDetails((current) => {
              const { [name]: _removed, ...rest } = current;
              return rest;
            });
            setBagWeights((current) => {
              const { [name]: _removed, ...rest } = current;
              return rest;
            });
            setDisc((current) => (current === name ? remaining[0] ?? '' : current));
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
  };


  const setHolePar = (par: number, targetHole: number) => {
    if (!selectedCourse) return;
    updateCourseLayout(selectedCourse.id, selectedCourse.layoutId, (layout) => {
      const layouts = fullHoleLayouts(layout);
      layouts[targetHole - 1] = { ...layouts[targetHole - 1], par };
      return { ...layout, layouts };
    });
  };


  return {
    loaded,
    courses, setCourses, updateCourses, updateCourseLayout, fullHoleLayouts, history, setHistory,
    bag, bagDetails, bagWeights, disc, setDisc, addDisc, deleteDisc, setDiscWeight, addCatalogDisc,
    selectedCourseId, setSelectedCourseId, selectedLayoutId, setSelectedLayoutId, selectedBaseCourse, selectedCourse, selectedCourseLayouts, hasMultipleLayouts,
    locationAllowed, setLocationAllowed, dimRound, setDimRound,
    mode, hole, setHole, shots, setShots, sessionActive, practiceFocus, setPracticeFocus, resumedFrom, roundMessage, setRoundMessage, throwStyle, setThrowStyle, pendingThrow, setPendingThrow,
    archiveSession, beginSession, confirmNewSession, finishSession, resumeSession, deleteRound, updateSessionShots, setRoundShared,
    selectLayout, deleteLayout, setHolePar, addHoleToCourse, deleteHole, deleteCourse, updateCourseDetails, setCoursePublished, addPublicCourse,
    newCourseStep, setNewCourseStep, newCourseId, courseName, setCourseName, startNewCourse, saveNewCourseName, mapLayout,
    account, syncing, syncError, setSyncError, pendingChanges, runSync, signOutLocally, finishSignIn,
  };
};

export type AppStateValue = ReturnType<typeof useAppState>;

const AppContext = createContext<AppStateValue | null>(null);

export const AppProvider = ({ children }: { children: ReactNode }) => (
  <AppContext.Provider value={useAppState()}>{children}</AppContext.Provider>
);

export const useApp = () => {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
};
