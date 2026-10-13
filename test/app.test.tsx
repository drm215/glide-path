/// <reference types="jest" />
// Drives the whole app through its main flows with native modules mocked (see setup.ts).
// These pin down behavior so the screens can be reorganized without changing what they do.
import type AsyncStorageModule from '@react-native-async-storage/async-storage';
import type * as RouterTesting from 'expo-router/testing-library';
import type * as BrightnessModule from 'expo-brightness';
import type * as SecureStoreModule from 'expo-secure-store';
import type { AlertButton, AlertStatic } from 'react-native';
import type { Course, SessionArchive } from '../lib/types';

const KEYS = {
  round: 'flight-notes-round-v1',
  history: 'flight-notes-history-v1',
  courses: 'flight-notes-courses-v1',
  bag: 'flight-notes-bag-v1',
  settings: 'flight-notes-settings-v1',
  sync: 'flight-notes-sync-v1',
  lastAccount: 'flight-notes-last-account-v1',
};

const point = (latitude: number, longitude: number) => ({ latitude, longitude, accuracy: 3, timestamp: 1, altitude: 100 });

const cedarGrove: Course = {
  id: 'course-1', name: 'Cedar Grove', holes: 2, updatedAt: 5,
  layouts: [{ tee: point(40, -75), basket: point(40.001, -75), par: 3 }, { tee: null, basket: null, par: 4 }],
};

const pastRound: SessionArchive = {
  id: '1727000000000', mode: 'Round', courseName: 'Cedar Grove', courseId: 'course-1', updatedAt: 6,
  shots: [
    { x: 0.5, y: 0.5, feet: 300, disc: 'Buzzz', type: 'Drive', hole: 1, lie: 'Fairway', latitude: 40.0008, longitude: -75 },
    { x: 0.5, y: 0.5, feet: 60, disc: 'Buzzz', type: 'Putt', hole: 1, lie: 'Basket', latitude: 40.001, longitude: -75 },
  ],
};

// Each test loads a fresh copy of the app, the router and the mocked native modules, so navigation
// and storage can't carry over from one test to the next (Expo Router keeps module-level state).
let renderRouter: typeof RouterTesting.renderRouter;
let testing: typeof RouterTesting;
// The testing library swaps in a new `screen` on every render, so always read the current one.
const screen = new Proxy({} as typeof RouterTesting.screen, { get: (_, key) => testing.screen[key as keyof typeof testing.screen] });
let fireEvent: typeof RouterTesting.fireEvent;
let waitFor: typeof RouterTesting.waitFor;
let cleanup: typeof RouterTesting.cleanup;
let AsyncStorage: typeof AsyncStorageModule;
let Brightness: typeof BrightnessModule;
let SecureStore: typeof SecureStoreModule;
let alertSpy: jest.SpyInstance<void, Parameters<AlertStatic['alert']>>;

beforeEach(() => {
  jest.resetModules();
  testing = require('expo-router/testing-library');
  testing.configure({ asyncUtilTimeout: 5_000 });
  ({ renderRouter, fireEvent, waitFor, cleanup } = testing);
  const storage = require('@react-native-async-storage/async-storage');
  AsyncStorage = storage.default ?? storage;
  Brightness = require('expo-brightness');
  SecureStore = require('expo-secure-store');
  alertSpy = jest.spyOn((require('react-native') as { Alert: AlertStatic }).Alert, 'alert');
});

// Glide Path needs an account, so every test starts signed in (tests about signing in sign out
// first), with a server that answers sync and nothing else unless a test says so.
const SIGNED_IN = { user: { id: 'u1', email: 'pat@example.com', displayName: 'Pat' }, cursor: 0, pushedThrough: Number.MAX_SAFE_INTEGER };
const EMPTY_SYNC = () => ({ cursor: 1, more: false, courses: [], rounds: [], bag: null });

beforeEach(async () => {
  // The storage mock is shared across reloads (setup.ts), so empty it.
  await AsyncStorage.clear();
  await seed({ [KEYS.sync]: SIGNED_IN });
  await SecureStore.setItemAsync('glide-path-token', 'token-1');
  mockServer({ '/api/sync': EMPTY_SYNC });
});

// For the tests about signing in.
const signOutFirst = async () => {
  await AsyncStorage.removeItem(KEYS.sync);
  await SecureStore.deleteItemAsync('glide-path-token');
};

afterEach(async () => {
  await cleanup();
  // renderRouter switches to fake timers; drop any still pending so none fire after the test.
  jest.clearAllTimers();
  jest.useRealTimers();
});

// Starts the app from its routes (src/app), on the home screen unless `url` says otherwise.
const renderApp = async (url = '/') => {
  await renderRouter('src/app', { initialUrl: url });
};

const seed = (values: Record<string, unknown>) =>
  AsyncStorage.multiSet(Object.entries(values).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));

// Reads the storage mock's memory directly, so checks can run inside a synchronous waitFor
// (an async one can start a new check before the last one ends, overlapping React's act()).
const stored = <T,>(key: string): T | null => {
  const raw = (AsyncStorage as unknown as { __INTERNAL_MOCK_STORAGE__: Record<string, string | undefined> }).__INTERNAL_MOCK_STORAGE__[key];
  return raw == null ? null : JSON.parse(raw) as T;
};

// Buttons during a round need a press-and-hold.
const hold = (text: string | RegExp) => fireEvent(screen.getByText(text), 'longPress');
const press = (text: string | RegExp) => fireEvent.press(screen.getByText(text));

// Presses a button in the most recent alert that has it.
const pressAlertButton = async (text: string) => {
  const call = [...alertSpy.mock.calls].reverse().find(([, , buttons]) => buttons?.some((button: AlertButton) => button.text === text));
  if (!call) throw new Error(`No alert with a "${text}" button`);
  await testing.act(async () => { await (call[2] as AlertButton[]).find((button) => button.text === text)!.onPress?.(); });
};

type Route = (body: unknown) => unknown;
// Answers the app's server requests by path; anything else fails the test.
const mockServer = (routes: Record<string, Route>) => {
  const requests: { path: string; body: unknown }[] = [];
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body });
    const route = routes[path];
    if (!route) throw new Error(`Unexpected request to ${path}`);
    return new Response(JSON.stringify(route(body)), { status: 200 });
  }) as unknown as typeof fetch;
  return requests;
};

test('opens on the home screen', async () => {
  await renderApp();
  expect(await screen.findByText('Ready when you are.')).toBeTruthy();
});

test('loads saved data, and backs up a value it cannot read instead of overwriting it', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound], [KEYS.bag]: '{not json' });
  await renderApp();
  await press('Rounds');
  expect(await screen.findByText('Cedar Grove')).toBeTruthy();
  const keys = await AsyncStorage.getAllKeys();
  const backup = keys.find((key) => key.startsWith(`${KEYS.bag}-unreadable-`));
  expect(backup).toBeDefined();
  expect(await AsyncStorage.getItem(backup!)).toBe('{not json');
});

test('moves past sessions saved with the round in progress to their own key', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.round]: { shots: [], hole: 1, mode: 'Round', history: [pastRound] } });
  await renderApp();
  await screen.findByText('Ready when you are.');
  await waitFor(() => expect(stored<SessionArchive[]>(KEYS.history)).toHaveLength(1));
  await waitFor(() => expect(stored<{ history?: unknown }>(KEYS.round)).not.toHaveProperty('history'));
});

test('plays a round: pick the course, log a throw into the basket, end, and see the summary', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.bag]: ['Buzzz'] });
  await renderApp();
  await press(await screen.findByText('Start a round').then(() => 'Start a round'));
  await press('Cedar Grove');
  expect(await screen.findByText('LOG THROW 1')).toBeTruthy();

  // One sheet for the details (taps, starting from the guesses); a throw in the basket saves at the
  // mapped basket straight from the sheet and moves to the next hole.
  await hold('LOG THROW 1');
  await press(await screen.findByText('Buzzz').then(() => 'Buzzz'));
  await press('Backhand');
  await press('Basket');
  await hold('SAVE · NEXT HOLE ›');
  expect(await screen.findByText(/Hole 1 complete in 1 stroke/)).toBeTruthy();
  await waitFor(() => {
    const round = stored<{ shots: { lie: string; accuracy: number; disc: string; type: string; hole: number }[]; hole: number }>(KEYS.round);
    expect(round?.shots).toEqual([expect.objectContaining({ lie: 'Basket', disc: 'Buzzz', type: 'Drive', hole: 1, accuracy: 3 })]);
    expect(round?.hole).toBe(2);
  });

  await hold('END ROUND');
  await pressAlertButton('End');
  expect(await screen.findByText('FINAL SCORE')).toBeTruthy();
  await waitFor(() => {
    const history = stored<SessionArchive[]>(KEYS.history);
    expect(history).toHaveLength(1);
    // The pars it was played with, so later course edits don't rescore it.
    expect(history?.[0]).toMatchObject({ courseId: 'course-1', mode: 'Round', pars: [3] });
  });
  await press('DONE');
  expect(await screen.findByText('Ready when you are.')).toBeTruthy();
});

test('logging a throw: enter the details, go back to the map, then save the location at the disc', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.bag]: ['Buzzz', 'Destroyer'] });
  await renderApp();
  await press(await screen.findByText('Start a round').then(() => 'Start a round'));
  await press('Cedar Grove');
  const location = (require('expo-location') as { __state: { position: { latitude: number; longitude: number }; accuracy: number | null } }).__state;
  location.position = { latitude: 40.0008, longitude: -75 };

  await hold(await screen.findByText('LOG THROW 1').then(() => 'LOG THROW 1'));
  await press(await screen.findByText('Destroyer').then(() => 'Destroyer'));
  await press('Forehand');
  await press('Woods');
  await press('Good');
  await press('NEXT ›');
  // Back on the round screen, the throw waits below the map; EDIT reopens the details.
  expect(await screen.findByText('THROW 1 · READY TO SAVE')).toBeTruthy();
  expect(screen.queryByText('LOG THROW 1')).toBeNull();
  await hold('EDIT');
  await press(await screen.findByText('Backhand').then(() => 'Backhand'));
  await press('Forehand');
  await press('NEXT ›');
  await hold(await screen.findByText('SAVE LOCATION ✓').then(() => 'SAVE LOCATION ✓'));
  await waitFor(() => {
    const round = stored<{ shots: Record<string, unknown>[] }>(KEYS.round);
    expect(round?.shots).toEqual([expect.objectContaining({ disc: 'Destroyer', type: 'Drive', style: 'Forehand', lie: 'Woods', quality: 3, latitude: 40.0008, accuracy: 4 })]);
  });
  expect(await screen.findByText('LOG THROW 2')).toBeTruthy();

  // A poor reading asks first; SAVE ANYWAY keeps it, without taking another.
  location.position = { latitude: 40.0009, longitude: -75 };
  location.accuracy = 30;
  await hold('LOG THROW 2');
  await press(await screen.findByText('NEXT ›').then(() => 'NEXT ›'));
  await hold(await screen.findByText('SAVE LOCATION ✓').then(() => 'SAVE LOCATION ✓'));
  expect(await screen.findByText(/only accurate to about 30 m/)).toBeTruthy();
  expect(stored<{ shots: unknown[] }>(KEYS.round)?.shots).toHaveLength(1);
  location.accuracy = 4;
  await hold('SAVE ANYWAY');
  await waitFor(() => expect(stored<{ shots: { accuracy: number }[] }>(KEYS.round)?.shots.map((shot) => shot.accuracy)).toEqual([4, 30]));

  // Cancelling, in the sheet or below the map, records nothing.
  await hold(await screen.findByText('LOG THROW 3').then(() => 'LOG THROW 3'));
  await press(await screen.findByText('CANCEL').then(() => 'CANCEL'));
  await hold('LOG THROW 3');
  await press(await screen.findByText('NEXT ›').then(() => 'NEXT ›'));
  await hold(await screen.findByText('CANCEL THROW').then(() => 'CANCEL THROW'));
  expect(await screen.findByText('LOG THROW 3')).toBeTruthy();
  expect(stored<{ shots: unknown[] }>(KEYS.round)?.shots).toHaveLength(2);
});

test('putts skip the throw-style question and are saved without a style', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.bag]: ['Aviar'] });
  await renderApp();
  await press(await screen.findByText('Start a round').then(() => 'Start a round'));
  await press('Cedar Grove');
  await hold(await screen.findByText('LOG THROW 1').then(() => 'LOG THROW 1'));
  expect(await screen.findByText('HOW DID YOU THROW IT?')).toBeTruthy();
  await press('Putt');
  expect(screen.queryByText('HOW DID YOU THROW IT?')).toBeNull();
  expect(screen.queryByText('Forehand')).toBeNull();
  // Switching back brings the question back.
  await press('Drive');
  expect(await screen.findByText('HOW DID YOU THROW IT?')).toBeTruthy();
  await press('Putt');
  await press('Made');
  await hold('SAVE · NEXT HOLE ›');
  await waitFor(() => {
    const [putt] = stored<{ shots: Record<string, unknown>[] }>(KEYS.round)!.shots;
    expect(putt).toMatchObject({ type: 'Putt', lie: 'Basket' });
    expect(putt).not.toHaveProperty('style');
  });
});

test('a made putt on a hole with no mapped basket saves where the player stands and moves on', async () => {
  const unmapped: Course = { ...cedarGrove, layouts: [{ tee: point(40, -75), basket: null, par: 3 }, { tee: null, basket: null, par: 4 }] };
  await seed({ [KEYS.courses]: [unmapped], [KEYS.bag]: ['Aviar'] });
  await renderApp();
  await press(await screen.findByText('Start a round').then(() => 'Start a round'));
  await press('Cedar Grove');
  const location = (require('expo-location') as { __state: { position: { latitude: number; longitude: number } } }).__state;
  location.position = { latitude: 40.0011, longitude: -75 };
  await hold(await screen.findByText('LOG THROW 1').then(() => 'LOG THROW 1'));
  await press(await screen.findByText('Putt').then(() => 'Putt'));
  await press('Made');
  await hold('SAVE · NEXT HOLE ›');
  expect(await screen.findByText(/Hole 1 complete in 1 stroke/)).toBeTruthy();
  await waitFor(() => {
    const round = stored<{ shots: Record<string, unknown>[]; hole: number }>(KEYS.round)!;
    expect(round.shots).toEqual([expect.objectContaining({ type: 'Putt', lie: 'Basket', latitude: 40.0011 })]);
    expect(round.hole).toBe(2);
  });
});

test('a GPS problem keeps the throw waiting, to try again', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.bag]: ['Buzzz'] });
  await renderApp();
  await press(await screen.findByText('Start a round').then(() => 'Start a round'));
  await press('Cedar Grove');
  const Location = require('expo-location') as { getCurrentPositionAsync: jest.Mock };
  Location.getCurrentPositionAsync.mockRejectedValueOnce(new Error('no fix'));
  await hold(await screen.findByText('LOG THROW 1').then(() => 'LOG THROW 1'));
  await press('Hazard');
  await press('NEXT ›');
  await hold(await screen.findByText('SAVE LOCATION ✓').then(() => 'SAVE LOCATION ✓'));
  expect(await screen.findByText(/Could not get a GPS fix/)).toBeTruthy();
  await hold('SAVE LOCATION ✓');
  await waitFor(() => expect(stored<{ shots: { lie: string }[] }>(KEYS.round)?.shots.map((shot) => shot.lie)).toEqual(['Hazard']));
});

test('a made putt on the last hole is saved with the round when it ends from the prompt', async () => {
  const oneHole: Course = { ...cedarGrove, holes: 1, layouts: [cedarGrove.layouts![0]] };
  await seed({ [KEYS.courses]: [oneHole], [KEYS.bag]: ['Aviar'] });
  await renderApp();
  await press(await screen.findByText('Start a round').then(() => 'Start a round'));
  await press('Cedar Grove');
  await hold(await screen.findByText('LOG THROW 1').then(() => 'LOG THROW 1'));
  await press(await screen.findByText('Putt').then(() => 'Putt'));
  await press('Made');
  await hold('SAVE ✓');
  await pressAlertButton('End round & see summary');
  expect(await screen.findByText('FINAL SCORE')).toBeTruthy();
  await waitFor(() => {
    const history = stored<SessionArchive[]>(KEYS.history);
    expect(history).toHaveLength(1);
    expect(history![0].shots).toEqual([expect.objectContaining({ type: 'Putt', lie: 'Basket' })]);
  });
});

test('a waiting throw stays on its hole: hole controls are off until it is saved or cancelled', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.bag]: ['Buzzz'] });
  await renderApp();
  await press(await screen.findByText('Start a round').then(() => 'Start a round'));
  await press('Cedar Grove');
  await hold(await screen.findByText('LOG THROW 1').then(() => 'LOG THROW 1'));
  await press(await screen.findByText('NEXT ›').then(() => 'NEXT ›'));
  expect(await screen.findByText('THROW 1 · READY TO SAVE')).toBeTruthy();
  // Trying to move on does nothing while the throw waits.
  await fireEvent(screen.getByLabelText('Next hole'), 'longPress');
  await hold('FINISH HOLE ↗');
  expect(screen.getByText('01 / 2')).toBeTruthy();
  expect(screen.getByText(/Save or cancel the waiting throw/)).toBeTruthy();
  await hold('SAVE LOCATION ✓');
  await waitFor(() => expect(stored<{ shots: { hole: number }[]; hole: number }>(KEYS.round)).toMatchObject({ hole: 1, shots: [{ hole: 1 }] }));
  // Once saved, the controls work again.
  await fireEvent(screen.getByLabelText('Next hole'), 'longPress');
  await waitFor(() => expect(stored<{ hole: number }>(KEYS.round)?.hole).toBe(2));
});

test('a waiting throw survives leaving the round screen', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.bag]: ['Buzzz'] });
  await renderApp();
  await press(await screen.findByText('Start a round').then(() => 'Start a round'));
  await press('Cedar Grove');
  await hold(await screen.findByText('LOG THROW 1').then(() => 'LOG THROW 1'));
  await press(await screen.findByText('Woods').then(() => 'Woods'));
  await press('NEXT ›');
  expect(await screen.findByText('THROW 1 · READY TO SAVE')).toBeTruthy();
  await waitFor(() => expect(stored<{ pendingThrow: unknown }>(KEYS.round)?.pendingThrow).toMatchObject({ lie: 'Woods' }));

  await fireEvent(screen.getByLabelText('Glide Path home'), 'longPress');
  await press(await screen.findByText('Resume round').then(() => 'Resume round'));
  expect(await screen.findByText('THROW 1 · READY TO SAVE')).toBeTruthy();
  await hold('SAVE LOCATION ✓');
  await waitFor(() => {
    const round = stored<{ shots: { lie: string }[]; pendingThrow: unknown }>(KEYS.round)!;
    expect(round.shots.map((shot) => shot.lie)).toEqual(['Woods']);
    expect(round.pendingThrow).toBeNull();
  });
});

test('a waiting throw saved before the app closed is still there when it reopens, until the round ends', async () => {
  await seed({
    [KEYS.courses]: [cedarGrove], [KEYS.bag]: ['Buzzz'],
    [KEYS.round]: { shots: [], hole: 1, mode: 'Round', courseId: 'course-1', active: true, pendingThrow: { disc: 'Buzzz', type: 'Drive', style: 'Forehand', lie: 'Hazard', quality: 2 } },
  });
  await renderApp();
  await press(await screen.findByText('Resume round').then(() => 'Resume round'));
  expect(await screen.findByText('THROW 1 · READY TO SAVE')).toBeTruthy();
  expect(screen.getByText('Buzzz forehand drive · hazard · quality 2/3')).toBeTruthy();
  await hold('SAVE LOCATION ✓');
  await waitFor(() => expect(stored<{ shots: unknown[] }>(KEYS.round)?.shots).toEqual([expect.objectContaining({ lie: 'Hazard', style: 'Forehand', quality: 2 })]));

  // Ending the round clears any waiting throw along with it.
  await hold('LOG THROW 2');
  await press(await screen.findByText('NEXT ›').then(() => 'NEXT ›'));
  await hold(await screen.findByText('CANCEL THROW').then(() => 'CANCEL THROW'));
  await hold(await screen.findByText('END ROUND').then(() => 'END ROUND'));
  await pressAlertButton('End');
  await waitFor(() => expect(stored<{ pendingThrow: unknown; shots: unknown[] }>(KEYS.round)).toMatchObject({ pendingThrow: null, shots: [] }));
});

test('the round screen dims, and the dimming switch is saved and restores brightness', async () => {
  await seed({ [KEYS.courses]: [cedarGrove] });
  await renderApp();
  await press(await screen.findByText('Start a round').then(() => 'Start a round'));
  await press('Cedar Grove');
  await waitFor(() => expect(Brightness.setBrightnessAsync).toHaveBeenCalledWith(0.3));
  await hold('SCREEN DIMMING: ON');
  expect(await screen.findByText('SCREEN DIMMING: OFF')).toBeTruthy();
  await waitFor(() => expect(Brightness.setBrightnessAsync).toHaveBeenLastCalledWith(0.8));
  await waitFor(() => expect(stored(KEYS.settings)).toEqual({ dimRound: false }));
});

test('maps a hole: save the tee and basket where the player stands, set par, add a hole, finish', async () => {
  await seed({ [KEYS.courses]: [{ ...cedarGrove, holes: 1, layouts: [{ tee: null, basket: null }] }] });
  await renderApp();
  await press(await screen.findByText('Course builder').then(() => 'Course builder'));
  await press('MAP SELECTED COURSE ↗');
  expect(await screen.findByText('Hole 01.')).toBeTruthy();
  const location = (require('expo-location') as { __state: { position: { latitude: number; longitude: number } } }).__state;
  location.position = { latitude: 41, longitude: -76 };
  await fireEvent.press(screen.getAllByText('SAVE LOCATION')[0]);
  location.position = { latitude: 41.001, longitude: -76 };
  await fireEvent.press(await screen.findByText('SAVE LOCATION'));
  await fireEvent.press(screen.getByLabelText('Par 3'));
  await waitFor(() => {
    const [course] = (stored<Course[]>(KEYS.courses))!;
    expect(course.layouts?.[0]).toMatchObject({ tee: { latitude: 41 }, basket: { latitude: 41.001 }, par: 3 });
  });
  await press('+ ADD HOLE');
  expect(await screen.findByText('Hole 02.')).toBeTruthy();
  await waitFor(() => expect((stored<Course[]>(KEYS.courses))?.[0].holes).toBe(2));
  await press('FINISH ✓');
  expect(await screen.findByText('Course builder.')).toBeTruthy();
});

test('edits a throw in a past round: marking it made moves it to the basket and remeasures', async () => {
  const round: SessionArchive = { ...pastRound, shots: [pastRound.shots[0], { ...pastRound.shots[1], lie: 'Missed', latitude: 40.0009 }] };
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [round] });
  await renderApp();
  await press(await screen.findByText('Rounds').then(() => 'Rounds'));
  await press('Cedar Grove');
  await fireEvent.press(await screen.findByLabelText('Edit throw 2 on hole 1'));
  expect(await screen.findByText('Edit throw')).toBeTruthy();
  await press('Made');
  await press('SAVE');
  await waitFor(() => {
    const [saved] = (stored<SessionArchive[]>(KEYS.history))!;
    expect(saved.shots[1]).toMatchObject({ lie: 'Basket', latitude: 40.001, accuracy: 3 });
  });
});

test('practice sessions start from the practice screen and end back home', async () => {
  await seed({ [KEYS.courses]: [cedarGrove] });
  await renderApp();
  await press(await screen.findByText('Practice').then(() => 'Practice'));
  await press('Putting');
  await press('START PUTTING PRACTICE ↗');
  expect(await screen.findByText('PUTTING PRACTICE')).toBeTruthy();
  await hold('END PRACTICE');
  await pressAlertButton('End');
  expect(await screen.findByText('Ready when you are.')).toBeTruthy();
});

test('resumes a past round from its summary at the next unfinished hole', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  await renderApp();
  await press(await screen.findByText('Rounds').then(() => 'Rounds'));
  await press('Cedar Grove');
  await press(await screen.findByText('RESUME ROUND ▶').then(() => 'RESUME ROUND ▶'));
  expect(await screen.findByText('Resumed on hole 2.')).toBeTruthy();
  await waitFor(() => expect(stored(KEYS.history)).toEqual([]));
  await waitFor(() => expect(stored<{ shots: unknown[]; hole: number }>(KEYS.round)).toMatchObject({ hole: 2, shots: pastRound.shots }));
});

test('a past round shows its scorecard: score to par, the drive and green, putts and the throw in', async () => {
  const parked: SessionArchive = {
    ...pastRound,
    shots: [
      // About 55 ft short of the basket: inside C2, which is a green in regulation on a par 3.
      { x: 0.5, y: 0.5, feet: 310, disc: 'Buzzz', type: 'Drive', hole: 1, lie: 'Fairway', latitude: 40.00085, longitude: -75 },
      { x: 0.5, y: 0.5, feet: 55, disc: 'Aviar', type: 'Putt', hole: 1, lie: 'Basket', latitude: 40.001, longitude: -75 },
    ],
  };
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [parked] });
  await renderApp(`/rounds/${parked.id}`);
  expect(await screen.findByText('FINAL SCORE')).toBeTruthy();
  expect(screen.getAllByText('-1').length).toBeGreaterThan(0);
  expect(screen.getByText('C2 Putting')).toBeTruthy();
  expect(screen.getByText('1/1 C2 Putting')).toBeTruthy();
  expect(screen.getByText('0/1 C1R  1/1 C2R')).toBeTruthy();
  expect(screen.getByText('55')).toBeTruthy();
  // A hole's column opens its map.
  await fireEvent.press(screen.getByLabelText('Show map for hole 1'));
  expect(await screen.findByText('− MAP')).toBeTruthy();
});

test('a scorecard longer than nine holes is split into front and back nines', async () => {
  const eighteen: SessionArchive = {
    ...pastRound,
    shots: Array.from({ length: 18 }, (_, index) => ({ x: 0.5, y: 0.5, feet: 0, disc: 'Buzzz', type: 'Drive' as const, hole: index + 1, lie: 'Basket' as const })),
  };
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [eighteen] });
  await renderApp(`/rounds/${eighteen.id}`);
  expect(await screen.findByText('FINAL SCORE')).toBeTruthy();
  // Each nine repeats the row labels; the total column comes after hole 18 only.
  expect(screen.getAllByText('Score')).toHaveLength(2);
  expect(screen.getAllByText('TOT')).toHaveLength(1);
  expect(screen.getByLabelText('Show map for hole 18')).toBeTruthy();
});

test('a hole opens in 3D: the web page gets the hole, every round on it, and this round first', async () => {
  const laterRound: SessionArchive = { ...pastRound, id: '1727100000000' };
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound, laterRound] });
  await renderApp(`/rounds/${pastRound.id}`);
  await fireEvent.press(await screen.findByLabelText('Hole 1 in 3D'));
  expect(await screen.findByText('Hole 01.')).toBeTruthy();
  const webview = require('react-native-webview') as { __state: { last: { source: { uri: string }; onMessage: (event: unknown) => void } }; __posted: string[] };
  expect(webview.__state.last.source.uri).toBe('https://glidepathdiscgolf.com/3d?theme=dark');
  // The page says it's ready; the app answers with the hole.
  await testing.act(async () => { webview.__state.last.onMessage({ nativeEvent: { data: 'ready' } }); });
  const message = JSON.parse(webview.__posted.at(-1)!);
  expect(message.type).toBe('hole3d');
  expect(message.hole3d).toMatchObject({ hole: 1, layout: { par: 3 }, selected: [pastRound.id] });
  // Newest first, each with its throws on this hole.
  expect(message.hole3d.rounds.map((round: { id: string; shots: unknown[] }) => [round.id, round.shots.length])).toEqual([[laterRound.id, 2], [pastRound.id, 2]]);
});

test('rounds from before pars were saved take the course pars, once', async () => {
  // pastRound has no saved pars; hole 1 is a par 3 on the course.
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  await renderApp(`/rounds/${pastRound.id}`);
  expect(await screen.findByText('FINAL SCORE')).toBeTruthy();
  await waitFor(() => {
    const [saved] = stored<SessionArchive[]>(KEYS.history)!;
    expect(saved.pars).toEqual([3]);
    expect(saved.updatedAt).toBeGreaterThan(pastRound.updatedAt!);
  });
});

test('a round is scored against the par it was played with, not a changed course', async () => {
  // Played when hole 1 was a par 4; the course now says 3. 2 strokes is still two under.
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [{ ...pastRound, pars: [4] }] });
  await renderApp(`/rounds/${pastRound.id}`);
  expect(await screen.findByText('FINAL SCORE')).toBeTruthy();
  expect(screen.getAllByText('-2').length).toBeGreaterThan(0);
  expect(screen.queryByText('-1')).toBeNull();
});

test("a throw dragged on a past round's map moves there, and its hole is remeasured", async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  await renderApp(`/rounds/${pastRound.id}`);
  await fireEvent.press(await screen.findByLabelText('Show map for hole 1'));
  // The drive was logged about 73 ft short of the basket; drop it 30 ft short instead.
  const drive = await screen.findByTestId('throw-marker-1-1');
  await testing.act(async () => { drive.props.onDragEnd({ nativeEvent: { coordinate: { latitude: 40.001 - 30 / 364_000, longitude: -75 } } }); });
  await waitFor(() => {
    const [round] = stored<SessionArchive[]>(KEYS.history)!;
    expect(round.shots[0]).toMatchObject({ latitude: 40.001 - 30 / 364_000, accuracy: null });
    expect(Math.abs(round.shots[0].feet - 335)).toBeLessThanOrEqual(2);
    // The putt is now measured from the moved drive.
    expect(Math.abs(round.shots[1].feet - 30)).toBeLessThanOrEqual(1);
    expect(round.updatedAt).toBeGreaterThan(pastRound.updatedAt!);
  });
});

test('a tee dragged on the hole map is saved as placed by hand', async () => {
  await seed({ [KEYS.courses]: [cedarGrove] });
  await renderApp('/courses/map');
  const tee = await screen.findByTestId('tee-marker');
  await testing.act(async () => { tee.props.onDragEnd({ nativeEvent: { coordinate: { latitude: 40.0001, longitude: -75.0001 } } }); });
  expect(await screen.findByText('Tee box moved on the map.')).toBeTruthy();
  await waitFor(() => expect(stored<Course[]>(KEYS.courses)![0].layouts![0].tee).toMatchObject({ latitude: 40.0001, longitude: -75.0001, accuracy: null }));
});

test('a link to a round opens its summary, and its back button goes to the rounds list', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  await renderApp(`/rounds/${pastRound.id}`);
  expect(await screen.findByText('FINAL SCORE')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Back to rounds'));
  expect(await screen.findByText('Rounds.')).toBeTruthy();
});

test('deleting a course keeps a course added while its confirmation was open', async () => {
  mockServer({
    '/api/public/courses': () => ({ courses: [{ uid: 'pub-1', name: 'Oak Run', holes: 1, city: 'Media', state: 'PA', mappedBy: 'Sam', distanceMiles: null, mappedHoles: 1, par: 3, parHoles: 1, distanceFeet: 300, layoutCount: 1 }] }),
    '/api/public/courses/pub-1': () => ({ course: { uid: 'pub-1', name: 'Oak Run', holes: 1, layouts: [{ tee: point(41, -75), basket: point(41.001, -75), par: 3 }], details: {}, mappedBy: 'Sam', mappedHoles: 1, par: 3, parHoles: 1, distanceFeet: 300 } }),
    '/api/courses/pub-1/play': () => null,
    '/api/sync': EMPTY_SYNC,
  });
  await seed({ [KEYS.courses]: [cedarGrove] });
  await renderApp();
  await press(await screen.findByText('Course builder').then(() => 'Course builder'));
  await fireEvent.press(await screen.findByLabelText('Delete Cedar Grove'));
  // The confirmation is open; meanwhile another course arrives.
  await fireEvent.press(screen.getByLabelText('Back to the main menu'));
  await press(await screen.findByText('Find courses').then(() => 'Find courses'));
  await fireEvent.changeText(screen.getByPlaceholderText('e.g. Cedar Grove or PA'), 'Oak');
  await press('SEARCH');
  await press(await screen.findByText('Oak Run').then(() => 'Oak Run'));
  await press(await screen.findByText('PLAY THIS COURSE').then(() => 'PLAY THIS COURSE'));
  await waitFor(() => expect(stored<Course[]>(KEYS.courses)?.map((course) => course.name)).toEqual(['Cedar Grove', 'Oak Run']));
  await pressAlertButton('Delete course');
  await waitFor(() => expect(stored<Course[]>(KEYS.courses)?.map((course) => course.name)).toEqual(['Oak Run']));
});

test('creates a course from the new-course flow', async () => {
  await renderApp();
  await press(await screen.findByText('Course builder').then(() => 'Course builder'));
  await press('+ NEW COURSE');
  await fireEvent.changeText(screen.getByPlaceholderText('e.g. Cedar Grove'), 'Maple Hill');
  await press('NEXT: DETAILS ›');
  expect(await screen.findByText('Details.')).toBeTruthy();
  await waitFor(() => expect((stored<Course[]>(KEYS.courses))?.map((course) => course.name)).toContain('Maple Hill'));
});

test('adds a disc to the bag by name', async () => {
  mockServer({ '/disc': () => [] });
  await renderApp();
  await press(await screen.findByText('Bag builder').then(() => 'Bag builder'));
  await fireEvent.changeText(screen.getByPlaceholderText('Disc name or mold'), 'Destroyer');
  await press('ADD');
  await waitFor(() => expect(stored(KEYS.bag)).toEqual(['Destroyer']));
});

test('removing a disc keeps a disc added while its confirmation was open', async () => {
  mockServer({ '/disc': () => [] });
  await seed({ [KEYS.bag]: ['Buzzz', 'Aviar'] });
  await renderApp();
  await press(await screen.findByText('Bag builder').then(() => 'Bag builder'));
  await fireEvent.press(await screen.findByLabelText('Remove Buzzz from bag'));
  // The confirmation is open; meanwhile another disc arrives.
  await fireEvent.changeText(screen.getByPlaceholderText('Disc name or mold'), 'Destroyer');
  await press('ADD');
  await waitFor(() => expect(stored(KEYS.bag)).toEqual(['Buzzz', 'Aviar', 'Destroyer']));
  await pressAlertButton('Remove disc');
  await waitFor(() => expect(stored(KEYS.bag)).toEqual(['Aviar', 'Destroyer']));
});

test('stats summarize finished rounds', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  await renderApp();
  await press(await screen.findByText('Stats').then(() => 'Stats'));
  expect(await screen.findByText('Throw stats')).toBeTruthy();
  expect(screen.getByText('BEST ROUND')).toBeTruthy();
  // The drive landed in the fairway, outside the circles; the putt went in from about 73 ft.
  expect(screen.getByText('1/1 Fairway')).toBeTruthy();
  // No drive missed the fairway, so no scramble chances, but Scramble still shows.
  expect(screen.getByText('0/0 Scramble')).toBeTruthy();
  expect(screen.getByText('0/1 C1R  0/1 C2R')).toBeTruthy();
  expect(screen.getByText('0 OB   .000 OB rate')).toBeTruthy();
});

test('stats combine any courses picked, and By disc filters by several throw types at once', async () => {
  const backYard: Course = { id: 'course-2', name: 'Back Yard', holes: 1, updatedAt: 5, layouts: [{ tee: null, basket: null, par: 3 }] };
  const backYardRound: SessionArchive = {
    id: '1727200000000', mode: 'Round', courseName: 'Back Yard', courseId: 'course-2', updatedAt: 7,
    shots: [
      { x: 0.5, y: 0.5, feet: 200, disc: 'Destroyer', type: 'Drive', hole: 1, lie: 'Fairway' },
      { x: 0.5, y: 0.5, feet: 90, disc: 'Roc', type: 'Approach', hole: 1, lie: 'Fairway' },
      { x: 0.5, y: 0.5, feet: 10, disc: 'Aviar', type: 'Putt', hole: 1, lie: 'Basket' },
    ],
  };
  await seed({ [KEYS.courses]: [cedarGrove, backYard], [KEYS.history]: [pastRound, backYardRound] });
  await renderApp();
  await press(await screen.findByText('Stats').then(() => 'Stats'));
  await press(await screen.findByText('Cedar Grove (1)').then(() => 'Cedar Grove (1)'));
  // One course: its holes, no By course list.
  expect(await screen.findByText('By hole')).toBeTruthy();
  expect(screen.queryByText('By course')).toBeNull();

  // A second course adds to the first.
  await press('Back Yard (1)');
  expect(await screen.findByText('By course')).toBeTruthy();
  expect(screen.queryByText('By hole')).toBeNull();
  expect(screen.getByText('Across different courses')).toBeTruthy();

  // Taking one back out leaves the other; All courses clears the choice.
  await press('Cedar Grove (1)');
  expect(await screen.findByText('By hole')).toBeTruthy();
  await press('All courses (2)');
  expect(await screen.findByText('By course')).toBeTruthy();

  // By disc: Drive and Putt together leave out the approach (Roc).
  // The chips are pressed by role, since the throw-type table also has rows named Drive and Putt.
  await fireEvent.press(screen.getByRole('button', { name: 'Drive' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Putt' }));
  expect(screen.getByRole('button', { name: 'Drive', selected: true })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Putt', selected: true })).toBeTruthy();
  expect(screen.queryByText('Roc')).toBeNull();
  expect(screen.getByText('Aviar')).toBeTruthy();
  await press('All throws');
  expect(await screen.findByText('Roc')).toBeTruthy();
});

test('disc stats show the distances and quality of each disc, and filter by throw type', async () => {
  const drives: SessionArchive = {
    ...pastRound, id: '1727300000000',
    shots: [300, 320, 340, 360, 380].map((feet, index) => ({ x: 0.5, y: 0.5, feet, disc: 'Destroyer', type: 'Drive' as const, hole: 1, lie: 'Fairway' as const, quality: [3, 3, 2, 1, 3][index], qualityMax: 3 })),
  };
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [drives] });
  await renderApp();
  await press(await screen.findByText('Stats').then(() => 'Stats'));
  await press(await screen.findByText(/Disc stats/).then(() => /Disc stats/));
  expect(await screen.findByText('Discs.')).toBeTruthy();
  expect(screen.getByText('Destroyer')).toBeTruthy();
  // Min, average, 90th and 95th percentile, max.
  for (const feet of ['300 ft', '340 ft', '372 ft', '376 ft', '380 ft']) expect(screen.getByText(feet)).toBeTruthy();
  expect(screen.getByText('Good 3  ·  Fair 1  ·  Poor 1  ·  avg 2.4/3')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Putt' }));
  expect(await screen.findByText('No throws match yet.')).toBeTruthy();
  await press('All throws');
  expect(await screen.findByText('Destroyer')).toBeTruthy();
});

test('a disc opens each of its throws, longest first, keeping the throw-type filter', async () => {
  const mixed: SessionArchive = {
    ...pastRound, id: '1727400000000',
    shots: [
      { x: 0.5, y: 0.5, feet: 250, disc: 'Buzzz', type: 'Drive', style: 'Forehand', hole: 1, lie: 'Fairway', quality: 3, qualityMax: 3 },
      { x: 0.5, y: 0.5, feet: 310, disc: 'Buzzz', type: 'Drive', hole: 2, lie: 'Woods', quality: 1, qualityMax: 3 },
      { x: 0.5, y: 0.5, feet: 60, disc: 'Buzzz', type: 'Approach', hole: 2, lie: 'Fairway' },
    ],
  };
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [mixed] });
  await renderApp('/discs');
  expect(await screen.findByText('Discs.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Drive' }));
  await fireEvent.press(screen.getByLabelText('Every throw with the Buzzz'));

  expect(await screen.findByText('Buzzz.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Drive', selected: true })).toBeTruthy();
  expect(screen.getByText('Each throw, longest first')).toBeTruthy();
  // The card's figures come first; the last two distances are the throws, longest first.
  expect(screen.getAllByText(/^\d+ ft$/).map((node) => node.props.children).slice(-2)).toEqual(['310 ft', '250 ft']);
  expect(screen.getByText('Drive · woods · poor')).toBeTruthy();
  expect(screen.getByText('Drive · forehand · fairway · good')).toBeTruthy();
  expect(screen.queryByText(/^Approach ·/)).toBeNull();

  // A throw opens its round.
  await fireEvent.press(screen.getByLabelText(/^310 ft drive on/));
  expect(await screen.findByText('FINAL SCORE')).toBeTruthy();
});

test('stats leave out a distance measured from a poor GPS reading', async () => {
  const poorFix: SessionArchive = {
    ...pastRound, id: '1727000100000',
    shots: [{ x: 0.5, y: 0.5, feet: 500, disc: 'Destroyer', type: 'Drive', hole: 1, lie: 'Fairway', latitude: 40.0009, longitude: -75, accuracy: 30 }],
  };
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound, poorFix] });
  await renderApp();
  await press(await screen.findByText('Stats').then(() => 'Stats'));
  expect(await screen.findByText('Throw stats')).toBeTruthy();
  expect(screen.getAllByText('300 ft').length).toBeGreaterThan(0);
  expect(screen.queryByText('500 ft')).toBeNull();
});

test('stats open every throw recorded on a hole, across rounds', async () => {
  const laterRound: SessionArchive = {
    ...pastRound, id: '1727100000000',
    shots: [
      { x: 0.5, y: 0.5, feet: 250, disc: 'Destroyer', type: 'Drive', hole: 1, lie: 'Woods', latitude: 40.0007, longitude: -75 },
      { x: 0.5, y: 0.5, feet: 80, disc: 'Buzzz', type: 'Approach', hole: 1, lie: 'Fairway', latitude: 40.00095, longitude: -75 },
      { x: 0.5, y: 0.5, feet: 20, disc: 'Aviar', type: 'Putt', hole: 1, lie: 'Basket', latitude: 40.001, longitude: -75 },
    ],
  };
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound, laterRound] });
  await renderApp();
  await press(await screen.findByText('Stats').then(() => 'Stats'));
  await press(await screen.findByText('Cedar Grove (2)').then(() => 'Cedar Grove (2)'));
  expect(await screen.findByText('By hole')).toBeTruthy();
  // Hole 1 (par 3), played twice: average 2.5, best 2.
  expect(testing.within(screen.getByLabelText('Every throw on hole 1')).getByText('2.5')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Every throw on hole 1'));

  expect(await screen.findByText('Hole 01.')).toBeTruthy();
  expect(screen.getByText('Every throw')).toBeTruthy();
  expect(screen.getByText('Throws on this hole')).toBeTruthy();
  expect(screen.getByText('3 strokes (E) · Destroyer › Buzzz › Aviar')).toBeTruthy();
  expect(screen.getByText('2 strokes (-1) · Buzzz › Buzzz')).toBeTruthy();

  // Back returns to where it was opened from.
  await fireEvent.press(screen.getByLabelText('Back to the previous screen'));
  expect(await screen.findByText('By hole')).toBeTruthy();
});

test('a past round links to every throw on each of its holes', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  await renderApp(`/rounds/${pastRound.id}`);
  await fireEvent.press(await screen.findByLabelText('Every throw on hole 1, across all rounds'));
  expect(await screen.findByText('Hole 01.')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Back to the previous screen'));
  expect(await screen.findByText('FINAL SCORE')).toBeTruthy();
});

test('deleting a past round removes it from history', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  await renderApp();
  await press(await screen.findByText('Rounds').then(() => 'Rounds'));
  await fireEvent.press(screen.getByLabelText(/^Delete Cedar Grove round/));
  await pressAlertButton('Delete round');
  await waitFor(() => expect(stored(KEYS.history)).toEqual([]));
});

test('the app asks you to sign in before anything else', async () => {
  await signOutFirst();
  await renderApp();
  expect(await screen.findByText('Sign in.')).toBeTruthy();
  expect(screen.queryByText('Ready when you are.')).toBeNull();
});

test('signing in uploads this phone’s data and keeps the token in the keychain', async () => {
  await signOutFirst();
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  const requests = mockServer({
    '/api/auth/login': () => ({ token: 'token-1', user: { id: 'u1', email: 'pat@example.com', displayName: 'Pat' } }),
    '/api/sync': () => ({ cursor: 3, more: false, courses: [], rounds: [], bag: null }),
  });
  await renderApp();
  await screen.findByText('Sign in.');
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'pat@example.com');
  await fireEvent.changeText(screen.getByPlaceholderText('Password'), 'long enough');
  await press('SIGN IN');
  // Signed in, the app opens.
  expect(await screen.findByText('Ready when you are.')).toBeTruthy();
  await waitFor(() => expect(requests.some((request) => request.path === '/api/sync')).toBe(true));
  const upload = requests.find((request) => request.path === '/api/sync')!.body as { courses: { clientId: string }[]; rounds: { clientId: string }[] };
  expect(upload.courses.map((course) => course.clientId)).toEqual(['course-1']);
  expect(upload.rounds.map((round) => round.clientId)).toEqual([pastRound.id]);
  expect(await SecureStore.getItemAsync('glide-path-token')).toBe('token-1');
  await waitFor(() => expect(stored(KEYS.lastAccount)).toMatchObject({ id: 'u1', email: 'pat@example.com' }));
});

test('after updating, the app sends its courses once more, so edits the server turned away get merged', async () => {
  const requests = mockServer({ '/api/sync': () => ({ cursor: 1, more: false, courses: [], rounds: [], bag: null }) });
  // Everything here counts as already sent (pushedThrough is past every edit).
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.sync]: { user: { id: 'u1', email: 'pat@example.com', displayName: 'Pat' }, cursor: 5, pushedThrough: 10_000 } });
  await SecureStore.setItemAsync('glide-path-token', 'token-1');
  await renderApp();
  type Upload = { courses: { clientId: string }[] };
  await waitFor(() => expect(requests.some((request) => (request.body as Upload).courses.some((item) => item.clientId === 'course-1'))).toBe(true));
});

test('a round in progress uploads while it is being played, marked in progress', async () => {
  const requests = mockServer({ '/api/sync': () => ({ cursor: 1, more: false, courses: [], rounds: [], bag: null }) });
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.bag]: ['Buzzz'], [KEYS.sync]: { user: { id: 'u1', email: 'pat@example.com', displayName: 'Pat' }, cursor: 0, pushedThrough: 0 } });
  await SecureStore.setItemAsync('glide-path-token', 'token-1');
  await renderApp();
  // The launch sync is done; let the (fake) clock move on so the throw is a later edit.
  await waitFor(() => expect(requests.length).toBeGreaterThan(0));
  await testing.act(async () => { jest.advanceTimersByTime(1_000); });
  await press(await screen.findByText('Start a round').then(() => 'Start a round'));
  await press('Cedar Grove');
  await hold(await screen.findByText('LOG THROW 1').then(() => 'LOG THROW 1'));
  await press(await screen.findByText('NEXT ›').then(() => 'NEXT ›'));
  await hold(await screen.findByText('SAVE LOCATION ✓').then(() => 'SAVE LOCATION ✓'));
  type Upload = { rounds: { clientId: string; inProgress: boolean; shots: unknown[] }[] };
  await waitFor(() => expect(requests.some((request) => (request.body as Upload).rounds.some((round) => round.inProgress))).toBe(true));
  const live = requests.map((request) => request.body as Upload).flatMap((body) => body.rounds).find((round) => round.inProgress)!;
  expect(live.shots).toHaveLength(1);
  expect(live.clientId).toBe(stored<{ activeId: string }>(KEYS.round)?.activeId);
  // Nothing went into this phone's history: the round is still being played here.
  expect(stored(KEYS.history) ?? []).toEqual([]);
});

test('a round in progress on another device is tagged in Rounds and left out of stats', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [{ ...pastRound, inProgress: true }] });
  await renderApp();
  await press(await screen.findByText('Rounds').then(() => 'Rounds'));
  expect(await screen.findByText('IN PROGRESS')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Back to the main menu'));
  await press(await screen.findByText('Stats').then(() => 'Stats'));
  expect(await screen.findByText(/No finished rounds yet/)).toBeTruthy();
});

test('signing in to a different account asks first, and cancelling stays signed out', async () => {
  await signOutFirst();
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.lastAccount]: { id: 'u1', email: 'old@example.com', pushedThrough: 10 } });
  const requests = mockServer({
    '/api/auth/login': () => ({ token: 'token-2', user: { id: 'u2', email: 'new@example.com', displayName: 'New' } }),
  });
  await renderApp();
  await screen.findByText('Sign in.');
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'new@example.com');
  await fireEvent.changeText(screen.getByPlaceholderText('Password'), 'long enough');
  // Signing in waits on the question, so answer it as soon as it's asked.
  alertSpy.mockImplementationOnce((_title, _message, buttons) => { buttons?.find((button) => button.text === 'Cancel')?.onPress?.(); });
  await press('SIGN IN');
  expect(alertSpy).toHaveBeenCalledWith('Data from another account', expect.stringContaining('old@example.com'), expect.anything(), expect.anything());
  expect(await screen.findByText('Sign in.')).toBeTruthy();
  expect(requests.some((request) => request.path === '/api/sync')).toBe(false);
  expect(await SecureStore.getItemAsync('glide-path-token')).toBeNull();
});

test("a course's owners and admins invite others by email, as an owner or admin", async () => {
  const editors = [{ userId: 'u1', displayName: 'Pat', email: 'pat@example.com', role: 'owner', creator: true }];
  const requests = mockServer({
    '/api/sync': EMPTY_SYNC,
    '/api/courses/pub-cedar/editors': (body) => {
      if (body) editors.push({ userId: 'm1', displayName: 'Sam', email: (body as { email: string }).email, role: (body as { role: string }).role, creator: false });
      return { editors };
    },
  });
  await seed({ [KEYS.courses]: [{ ...cedarGrove, uid: 'pub-cedar' }] });
  await renderApp('/courses');
  expect(await screen.findByText('Owners and admins')).toBeTruthy();
  expect(await screen.findByText('Pat · Owner (created it) · pat@example.com')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Email to invite'), 'sam@example.com');
  await press('INVITE');
  expect(await screen.findByText('Sam · Admin · sam@example.com')).toBeTruthy();
  expect(requests.some((request) => request.path === '/api/courses/pub-cedar/editors' && (request.body as { role?: string })?.role === 'admin')).toBe(true);
});

test('a course you only play is not in Course builder, but is there to start a round on', async () => {
  const played: Course = { ...cedarGrove, id: 'shared-pub-cedar', uid: 'pub-cedar', role: 'player', createdBy: 'David' };
  await seed({ [KEYS.courses]: [played] });
  await renderApp('/courses');
  expect(await screen.findByText(/None yet\. Create one/)).toBeTruthy();
  expect(screen.queryByText('Cedar Grove')).toBeNull();
});

test('a duplicate course combines into the other: its holes, layouts and rounds move over', async () => {
  const gps = (latitude: number, timestamp: number) => ({ latitude, longitude: -75, accuracy: 3, timestamp });
  // David's Steele Creek, which this account was made an admin of.
  const davids: Course = {
    id: 'shared-pub-steele', uid: 'pub-steele', role: 'admin', createdBy: 'David', name: 'Steele Creek', holes: 1, updatedAt: 5,
    layouts: [{ tee: gps(40, 10), basket: gps(40.001, 10), par: 3 }], layoutName: 'Short tees',
    extraLayouts: [{ id: 'layout-long', name: 'Long tees', holes: 1, layouts: [{ tee: null, basket: null }] }],
  };
  // The one this account mapped itself, with the long tees (under a different layout id).
  const mine: Course = {
    id: 'mine-1', name: 'Steele Creek', holes: 1, updatedAt: 6, layoutName: 'Short tees', layouts: [{ tee: null, basket: null, par: 3 }],
    extraLayouts: [{ id: 'layout-mine', name: 'long tees', holes: 2, layouts: [{ tee: gps(41, 20), basket: gps(41.001, 20), par: 4 }, { tee: gps(41.01, 20), basket: gps(41.011, 20), par: 3 }] }],
  };
  const myRound: SessionArchive = { ...pastRound, id: '1727500000000', courseId: 'mine-1', courseName: 'Steele Creek', layoutId: 'layout-mine' };
  await seed({ [KEYS.courses]: [davids, mine], [KEYS.history]: [myRound] });
  await renderApp('/courses');
  // Select this account's own one, the second in the list.
  await screen.findAllByText('Steele Creek');
  await fireEvent.press(screen.getAllByText('Steele Creek')[1]);
  await fireEvent.press(await screen.findByLabelText('Combine into the other Steele Creek'));
  await pressAlertButton('Combine');
  await waitFor(() => {
    const courses = stored<Course[]>(KEYS.courses)!;
    expect(courses.map((course) => course.id)).toEqual(['shared-pub-steele']);
    const long = courses[0].extraLayouts![0];
    expect(long).toMatchObject({ id: 'layout-long', holes: 2 });
    expect(long.layouts.map((hole) => hole.tee?.latitude)).toEqual([41, 41.01]);
    // The round moved to David's course and its matching layout.
    expect(stored<SessionArchive[]>(KEYS.history)![0]).toMatchObject({ courseId: 'shared-pub-steele', layoutId: 'layout-long' });
  });
});

test('finds a course and plays it: the live course, not a copy', async () => {
  const requests = mockServer({
    '/api/sync': EMPTY_SYNC,
    '/api/public/courses': () => ({ courses: [{ uid: 'pub-1', name: 'Oak Run', holes: 1, city: 'Media', state: 'PA', mappedBy: 'Sam', distanceMiles: null, mappedHoles: 1, par: 3, parHoles: 1, distanceFeet: 300, layoutCount: 1 }] }),
    '/api/public/courses/pub-1': () => ({ course: { uid: 'pub-1', name: 'Oak Run', holes: 1, layouts: [{ tee: point(41, -75), basket: point(41.001, -75), par: 3 }], details: { city: 'Media' }, mappedBy: 'Sam', mappedHoles: 1, par: 3, parHoles: 1, distanceFeet: 300, updatedAt: 77 } }),
    '/api/courses/pub-1/play': () => null,
  });
  await renderApp();
  await press(await screen.findByText('Find courses').then(() => 'Find courses'));
  await fireEvent.changeText(screen.getByPlaceholderText('e.g. Cedar Grove or PA'), 'Oak');
  await press('SEARCH');
  await press(await screen.findByText('Oak Run').then(() => 'Oak Run'));
  await press(await screen.findByText('PLAY THIS COURSE').then(() => 'PLAY THIS COURSE'));
  await waitFor(() => expect(stored<Course[]>(KEYS.courses)?.find((course) => course.name === 'Oak Run')).toMatchObject({ id: 'shared-pub-1', uid: 'pub-1', role: 'player', createdBy: 'Sam' }));
  expect(requests.some((request) => request.path === '/api/courses/pub-1/play')).toBe(true);
  expect(await screen.findByText('IN YOUR COURSES ✓')).toBeTruthy();
});
