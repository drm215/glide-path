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

beforeEach(async () => {
  // The storage mock is shared across reloads (setup.ts), so empty it.
  await AsyncStorage.clear();
});

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
    expect(history?.[0]).toMatchObject({ courseId: 'course-1', mode: 'Round' });
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

test('a link to a round opens its summary, and its back button goes to the rounds list', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  await renderApp(`/rounds/${pastRound.id}`);
  expect(await screen.findByText('FINAL SCORE')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Back to rounds'));
  expect(await screen.findByText('Rounds.')).toBeTruthy();
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

test('stats summarize finished rounds', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  await renderApp();
  await press(await screen.findByText('Stats').then(() => 'Stats'));
  expect(await screen.findByText('Throw stats')).toBeTruthy();
  expect(screen.getByText('BEST ROUND')).toBeTruthy();
  expect(screen.getByText('AVG MADE PUTT')).toBeTruthy();
  expect(screen.getByText('LONGEST MADE PUTT')).toBeTruthy();
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
  expect(screen.getByText('Par 3 · played 2 times · avg 2.5 (-0.5) · best 2')).toBeTruthy();
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

test('signing in uploads this phone’s data and keeps the token in the keychain', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  const requests = mockServer({
    '/api/auth/login': () => ({ token: 'token-1', user: { id: 'u1', email: 'pat@example.com', displayName: 'Pat' } }),
    '/api/sync': () => ({ cursor: 3, more: false, courses: [], rounds: [], bag: null }),
  });
  await renderApp();
  await fireEvent.press(await screen.findByLabelText('Sign in'));
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'pat@example.com');
  await fireEvent.changeText(screen.getByPlaceholderText('Password'), 'long enough');
  await press('SIGN IN');
  expect(await screen.findByText('Your account.')).toBeTruthy();
  await waitFor(() => expect(requests.some((request) => request.path === '/api/sync')).toBe(true));
  const upload = requests.find((request) => request.path === '/api/sync')!.body as { courses: { clientId: string }[]; rounds: { clientId: string }[] };
  expect(upload.courses.map((course) => course.clientId)).toEqual(['course-1']);
  expect(upload.rounds.map((round) => round.clientId)).toEqual([pastRound.id]);
  expect(await SecureStore.getItemAsync('glide-path-token')).toBe('token-1');
  await waitFor(() => expect(stored(KEYS.lastAccount)).toMatchObject({ id: 'u1', email: 'pat@example.com' }));
});

test('signing in to a different account asks first, and cancelling stays signed out', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.lastAccount]: { id: 'u1', email: 'old@example.com', pushedThrough: 10 } });
  const requests = mockServer({
    '/api/auth/login': () => ({ token: 'token-2', user: { id: 'u2', email: 'new@example.com', displayName: 'New' } }),
  });
  await renderApp();
  await fireEvent.press(await screen.findByLabelText('Sign in'));
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

test('finds a published course and adds it to my courses', async () => {
  mockServer({
    '/api/public/courses': () => ({ courses: [{ uid: 'pub-1', name: 'Oak Run', holes: 1, city: 'Media', state: 'PA', mappedBy: 'Sam', distanceMiles: null, mappedHoles: 1, par: 3, parHoles: 1, distanceFeet: 300, layoutCount: 1 }] }),
    '/api/public/courses/pub-1': () => ({ course: { uid: 'pub-1', name: 'Oak Run', holes: 1, layouts: [{ tee: point(41, -75), basket: point(41.001, -75), par: 3 }], details: { city: 'Media' }, mappedBy: 'Sam', mappedHoles: 1, par: 3, parHoles: 1, distanceFeet: 300 } }),
  });
  await renderApp();
  await press(await screen.findByText('Find courses').then(() => 'Find courses'));
  await fireEvent.changeText(screen.getByPlaceholderText('e.g. Cedar Grove or PA'), 'Oak');
  await press('SEARCH');
  await press(await screen.findByText('Oak Run').then(() => 'Oak Run'));
  await press(await screen.findByText('ADD TO MY COURSES').then(() => 'ADD TO MY COURSES'));
  await waitFor(() => expect((stored<Course[]>(KEYS.courses))?.find((course) => course.name === 'Oak Run')).toMatchObject({ sourceUid: 'pub-1' }));
});
