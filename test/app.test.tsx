/// <reference types="jest" />
// Drives the whole app through its main flows with native modules mocked (see setup.ts).
// These pin down behavior so the screens can be reorganized without changing what they do.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Brightness from 'expo-brightness';
import * as SecureStore from 'expo-secure-store';
import { Alert, type AlertButton } from 'react-native';
import App from '../App';
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

const seed = (values: Record<string, unknown>) =>
  AsyncStorage.multiSet(Object.entries(values).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));

const stored = async <T,>(key: string): Promise<T | null> => {
  const raw = await AsyncStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw) as T;
};

// Buttons during a round need a press-and-hold.
const hold = (text: string | RegExp) => fireEvent(screen.getByText(text), 'longPress');
const press = (text: string | RegExp) => fireEvent.press(screen.getByText(text));

// Presses a button in the most recent alert that has it.
const alertSpy = jest.spyOn(Alert, 'alert');
const pressAlertButton = async (text: string) => {
  const call = [...alertSpy.mock.calls].reverse().find(([, , buttons]) => buttons?.some((button: AlertButton) => button.text === text));
  if (!call) throw new Error(`No alert with a "${text}" button`);
  await waitFor(async () => { await (call[2] as AlertButton[]).find((button) => button.text === text)!.onPress?.(); });
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

beforeEach(async () => {
  await AsyncStorage.clear();
  (SecureStore as unknown as { __store: Map<string, string> }).__store.clear();
  alertSpy.mockClear();
  jest.mocked(Brightness.setBrightnessAsync).mockClear();
});

test('opens on the home screen', async () => {
  await render(<App />);
  expect(await screen.findByText('Ready when you are.')).toBeTruthy();
});

test('loads saved data, and backs up a value it cannot read instead of overwriting it', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound], [KEYS.bag]: '{not json' });
  await render(<App />);
  await press('Rounds');
  expect(await screen.findByText('Cedar Grove')).toBeTruthy();
  const keys = await AsyncStorage.getAllKeys();
  const backup = keys.find((key) => key.startsWith(`${KEYS.bag}-unreadable-`));
  expect(backup).toBeDefined();
  expect(await AsyncStorage.getItem(backup!)).toBe('{not json');
});

test('moves past sessions saved with the round in progress to their own key', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.round]: { shots: [], hole: 1, mode: 'Round', history: [pastRound] } });
  await render(<App />);
  await screen.findByText('Ready when you are.');
  await waitFor(async () => expect(await stored<SessionArchive[]>(KEYS.history)).toHaveLength(1));
  await waitFor(async () => expect(await stored<{ history?: unknown }>(KEYS.round)).not.toHaveProperty('history'));
});

test('plays a round: pick the course, log a throw into the basket, end, and see the summary', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.bag]: ['Buzzz'] });
  await render(<App />);
  await press(await screen.findByText('Start a round').then(() => 'Start a round'));
  await press('Cedar Grove');
  expect(await screen.findByText('LOG THROW 1')).toBeTruthy();

  await hold('LOG THROW 1');
  await hold(await screen.findByText('Buzzz').then(() => 'Buzzz'));
  await hold('Backhand');
  await hold('Basket');
  expect(await screen.findByText(/Hole 1 complete in 1 stroke/)).toBeTruthy();
  await waitFor(async () => {
    const round = await stored<{ shots: { lie: string; accuracy: number; disc: string; type: string; hole: number }[]; hole: number }>(KEYS.round);
    expect(round?.shots).toEqual([expect.objectContaining({ lie: 'Basket', disc: 'Buzzz', type: 'Drive', hole: 1, accuracy: 3 })]);
    expect(round?.hole).toBe(2);
  });

  await hold('END ROUND');
  await pressAlertButton('End');
  expect(await screen.findByText('FINAL SCORE')).toBeTruthy();
  await waitFor(async () => {
    const history = await stored<SessionArchive[]>(KEYS.history);
    expect(history).toHaveLength(1);
    expect(history?.[0]).toMatchObject({ courseId: 'course-1', mode: 'Round' });
  });
});

test('the round screen dims, and the dimming switch is saved and restores brightness', async () => {
  await seed({ [KEYS.courses]: [cedarGrove] });
  await render(<App />);
  await press(await screen.findByText('Start a round').then(() => 'Start a round'));
  await press('Cedar Grove');
  await waitFor(() => expect(Brightness.setBrightnessAsync).toHaveBeenCalledWith(0.3));
  await hold('SCREEN DIMMING: ON');
  expect(await screen.findByText('SCREEN DIMMING: OFF')).toBeTruthy();
  await waitFor(() => expect(Brightness.setBrightnessAsync).toHaveBeenLastCalledWith(0.8));
  await waitFor(async () => expect(await stored(KEYS.settings)).toEqual({ dimRound: false }));
});

test('creates a course from the new-course flow', async () => {
  await render(<App />);
  await press(await screen.findByText('Course builder').then(() => 'Course builder'));
  await press('+ NEW COURSE');
  await fireEvent.changeText(screen.getByPlaceholderText('e.g. Cedar Grove'), 'Maple Hill');
  await press('NEXT: DETAILS ›');
  expect(await screen.findByText('Details.')).toBeTruthy();
  await waitFor(async () => expect((await stored<Course[]>(KEYS.courses))?.map((course) => course.name)).toContain('Maple Hill'));
});

test('adds a disc to the bag by name', async () => {
  mockServer({ '/disc': () => [] });
  await render(<App />);
  await press(await screen.findByText('Bag builder').then(() => 'Bag builder'));
  await fireEvent.changeText(screen.getByPlaceholderText('Disc name or mold'), 'Destroyer');
  await press('ADD');
  await waitFor(async () => expect(await stored(KEYS.bag)).toEqual(['Destroyer']));
});

test('stats summarize finished rounds', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  await render(<App />);
  await press(await screen.findByText('Stats').then(() => 'Stats'));
  expect(await screen.findByText('Throw stats')).toBeTruthy();
  expect(screen.getByText('BEST ROUND')).toBeTruthy();
});

test('deleting a past round removes it from history', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  await render(<App />);
  await press(await screen.findByText('Rounds').then(() => 'Rounds'));
  await fireEvent.press(screen.getByLabelText(/^Delete Cedar Grove round/));
  await pressAlertButton('Delete round');
  await waitFor(async () => expect(await stored(KEYS.history)).toEqual([]));
});

test('signing in uploads this phone’s data and keeps the token in the keychain', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.history]: [pastRound] });
  const requests = mockServer({
    '/api/auth/login': () => ({ token: 'token-1', user: { id: 'u1', email: 'pat@example.com', displayName: 'Pat' } }),
    '/api/sync': () => ({ cursor: 3, more: false, courses: [], rounds: [], bag: null }),
  });
  await render(<App />);
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
  await waitFor(async () => expect(await stored(KEYS.lastAccount)).toMatchObject({ id: 'u1', email: 'pat@example.com' }));
});

test('signing in to a different account asks first, and cancelling stays signed out', async () => {
  await seed({ [KEYS.courses]: [cedarGrove], [KEYS.lastAccount]: { id: 'u1', email: 'old@example.com', pushedThrough: 10 } });
  const requests = mockServer({
    '/api/auth/login': () => ({ token: 'token-2', user: { id: 'u2', email: 'new@example.com', displayName: 'New' } }),
  });
  await render(<App />);
  await fireEvent.press(await screen.findByLabelText('Sign in'));
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'new@example.com');
  await fireEvent.changeText(screen.getByPlaceholderText('Password'), 'long enough');
  // Signing in waits on the question, so answer it before awaiting the press.
  const signingIn = press('SIGN IN');
  await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Data from another account', expect.stringContaining('old@example.com'), expect.anything(), expect.anything()));
  await pressAlertButton('Cancel');
  await signingIn;
  expect(await screen.findByText('Sign in.')).toBeTruthy();
  expect(requests.some((request) => request.path === '/api/sync')).toBe(false);
  expect(await SecureStore.getItemAsync('glide-path-token')).toBeNull();
});

test('finds a published course and adds it to my courses', async () => {
  mockServer({
    '/api/public/courses': () => ({ courses: [{ uid: 'pub-1', name: 'Oak Run', holes: 1, city: 'Media', state: 'PA', mappedBy: 'Sam', distanceMiles: null, mappedHoles: 1, par: 3, parHoles: 1, distanceFeet: 300, layoutCount: 1 }] }),
    '/api/public/courses/pub-1': () => ({ course: { uid: 'pub-1', name: 'Oak Run', holes: 1, layouts: [{ tee: point(41, -75), basket: point(41.001, -75), par: 3 }], details: { city: 'Media' }, mappedBy: 'Sam', mappedHoles: 1, par: 3, parHoles: 1, distanceFeet: 300 } }),
  });
  await render(<App />);
  await press(await screen.findByText('Find courses').then(() => 'Find courses'));
  await fireEvent.changeText(screen.getByPlaceholderText('e.g. Cedar Grove or PA'), 'Oak');
  await press('SEARCH');
  await press(await screen.findByText('Oak Run').then(() => 'Oak Run'));
  await press(await screen.findByText('ADD TO MY COURSES').then(() => 'ADD TO MY COURSES'));
  await waitFor(async () => expect((await stored<Course[]>(KEYS.courses))?.find((course) => course.name === 'Oak Run')).toMatchObject({ sourceUid: 'pub-1' }));
});
