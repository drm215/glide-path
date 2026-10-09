// Runs the iPhone app's own sync code (lib/sync.ts) against the real API, as two devices on one account.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildSyncRequest, clearSentTombstones, countPendingChanges, initialBagUpdatedAt, mergeCourses, mergeRounds, sendInBatches, splitSyncRequest, type SyncAccount, type SyncData, type SyncResponse } from '../../lib/sync.ts';
import type { Course, SessionArchive } from '../../lib/types.ts';
import { startTestServer } from './helpers.ts';

type Server = Awaited<ReturnType<typeof startTestServer>>;
type Device = { data: SyncData; account: SyncAccount };

const emptyData = (): SyncData => ({ courses: [], history: [], bag: [], bagDetails: {}, bagWeights: {}, bagUpdatedAt: 0, deletedCourses: [], deletedRounds: [] });

// A logical clock keeps edit times strictly increasing without depending on real time.
let clock = 1_000;
const tick = () => (clock += 1_000);

// Mirrors App.tsx's runSync: upload in batches, merging each response as it arrives.
// Returns the whole upload and how many requests it took.
const syncDevice = async (server: Server, device: Device) => {
  const startedAt = tick();
  const body = buildSyncRequest(device.data, device.account);
  let requests = 0;
  await sendInBatches(body, async (batch) => {
    requests += 1;
    const response = await server.request('POST', '/api/sync', { token: device.account.token, body: batch });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as SyncResponse;
  }, (batch, result) => {
    device.data = {
      ...device.data,
      courses: mergeCourses(device.data.courses, result.courses),
      history: mergeRounds(device.data.history, result.rounds, device.data.activeRound?.id),
      deletedCourses: clearSentTombstones(device.data.deletedCourses, batch.courses),
      deletedRounds: clearSentTombstones(device.data.deletedRounds, batch.rounds),
      ...(result.bag && result.bag.updatedAt > device.data.bagUpdatedAt ? { bag: result.bag.discs, bagDetails: result.bag.details, bagWeights: result.bag.weights ?? {}, bagUpdatedAt: result.bag.updatedAt } : {}),
    };
    device.account = { ...device.account, cursor: result.cursor };
  });
  device.account = { ...device.account, pushedThrough: startedAt };
  return Object.assign(body, { requests });
};

const newDevice = (token: string, data = emptyData()): Device => ({
  data,
  account: { token, user: { id: '', email: '', displayName: '' }, cursor: 0, pushedThrough: 0 },
});

const course = (id: string, overrides: Partial<Course> = {}): Course => ({
  id,
  name: 'Cedar Grove',
  holes: 2,
  layouts: [
    { tee: { latitude: 40, longitude: -75, accuracy: 4, timestamp: 1, altitude: 90 }, basket: { latitude: 40.001, longitude: -75, accuracy: 4, timestamp: 2 }, par: 3 },
    { tee: null, basket: null },
  ],
  city: 'Media',
  state: 'PA',
  ...overrides,
});

const session = (id: string, overrides: Partial<SessionArchive> = {}): SessionArchive => ({
  id,
  mode: 'Round',
  courseName: 'Cedar Grove',
  courseId: 'course-1',
  shots: [
    { x: 0.5, y: 0.5, feet: 250, disc: 'Destroyer', type: 'Drive', hole: 1, lie: 'OB', quality: 1, qualityMax: 3, latitude: 40.0005, longitude: -75 },
    { x: 0.5, y: 0.5, feet: 30, disc: 'Aviar', type: 'Putt', hole: 1, lie: 'Basket', quality: 3, qualityMax: 3 },
  ],
  ...overrides,
});

describe('app sync against the API', () => {
  let server: Server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.stop();
  });

  test('existing on-phone data uploads on first sign-in, including records from before sync existed', async () => {
    const token = await server.register('first@example.com');
    // Data saved before sync: no updatedAt anywhere.
    const phone = newDevice(token, { ...emptyData(), courses: [course('course-1')], history: [session('round-1')] });
    assert.equal(countPendingChanges(phone.data, phone.account.pushedThrough), 2);

    const sent = await syncDevice(server, phone);
    assert.equal(sent.courses.length, 1);
    assert.equal(sent.rounds.length, 1);
    assert.ok(phone.data.courses[0].uid, 'course gains its server uid');
    assert.equal(countPendingChanges(phone.data, phone.account.pushedThrough), 0);

    // Nothing changed, so the next sync uploads nothing.
    const again = await syncDevice(server, phone);
    assert.equal(again.courses.length + again.rounds.length, 0);
  });

  test('edits, bag, and deletions flow between two devices', async () => {
    const token = await server.register('two-devices@example.com');
    const phone = newDevice(token, {
      ...emptyData(),
      courses: [course('course-1', { updatedAt: tick() }), course('course-2', { name: 'Second Park', updatedAt: tick() })],
      bag: ['Buzzz', 'Old Putter'],
      bagDetails: { Buzzz: { id: 'x', name: 'Buzzz', brand: 'Discraft', category: 'Midrange', speed: '5', glide: '4', turn: '-1', fade: '1', stability: 'Stable' } },
      // Weights only for discs in the bag are sent; the stale one is dropped.
      bagWeights: { Buzzz: 177.4, 'Old Putter': 173, 'Lost Disc': 170 },
      bagUpdatedAt: tick(),
    });
    await syncDevice(server, phone);

    // A second phone signs in and receives everything.
    const tablet = newDevice(token);
    await syncDevice(server, tablet);
    assert.deepEqual(tablet.data.courses.map((item) => item.name).sort(), ['Cedar Grove', 'Second Park']);
    assert.deepEqual(tablet.data.bag, ['Buzzz', 'Old Putter']);
    assert.equal(tablet.data.bagDetails.Buzzz.brand, 'Discraft');
    assert.deepEqual(tablet.data.bagWeights, { Buzzz: 177, 'Old Putter': 173 });
    assert.equal(tablet.data.courses.find((item) => item.id === 'course-1')!.layouts![0].tee!.altitude, 90);

    // The tablet changes a par; the phone picks it up.
    tablet.data.courses = tablet.data.courses.map((item) => item.id === 'course-1'
      ? { ...item, layouts: [{ ...item.layouts![0], par: 4 }, item.layouts![1]], updatedAt: tick() }
      : item);
    await syncDevice(server, tablet);
    await syncDevice(server, phone);
    assert.equal(phone.data.courses.find((item) => item.id === 'course-1')!.layouts![0].par, 4);

    // The phone deletes a course; the tablet loses it too.
    phone.data.courses = phone.data.courses.filter((item) => item.id !== 'course-2');
    phone.data.deletedCourses = [{ clientId: 'course-2', updatedAt: tick() }];
    await syncDevice(server, phone);
    assert.equal(phone.data.deletedCourses.length, 0, 'sent deletions are forgotten');
    await syncDevice(server, tablet);
    assert.deepEqual(tablet.data.courses.map((item) => item.id), ['course-1']);
  });

  test('a bag saved before sync uploads even after the account has already synced', async () => {
    const token = await server.register('legacy-bag@example.com');
    // The phone already synced once, with a bag that has no edit time (as loaded from storage).
    const phone = newDevice(token, { ...emptyData(), bag: ['Buzzz', 'Aviar'] });
    await syncDevice(server, phone);
    assert.equal(buildSyncRequest(phone.data, phone.account).bag, undefined, 'unstamped bag is never sent');

    // Relaunch: the app stamps the saved bag on load.
    phone.data.bagUpdatedAt = initialBagUpdatedAt(undefined, phone.data.bag.length, tick());
    await syncDevice(server, phone);

    const tablet = newDevice(token);
    tablet.data.bagUpdatedAt = initialBagUpdatedAt(undefined, 0, tick());
    assert.equal(tablet.data.bagUpdatedAt, 0, 'an empty bag is not stamped');
    await syncDevice(server, tablet);
    assert.deepEqual(tablet.data.bag, ['Buzzz', 'Aviar']);

    // Once stamped, the stored time is kept on later launches.
    assert.equal(initialBagUpdatedAt(phone.data.bagUpdatedAt, 2, tick()), phone.data.bagUpdatedAt);
  });

  test("a round in progress syncs as in progress, then as finished, and never lands in its own phone's history", async () => {
    const token = await server.register('live@example.com');
    const phone = newDevice(token);
    const tablet = newDevice(token);
    const live = session('live-1', { updatedAt: tick(), inProgress: true });
    phone.data.activeRound = live;
    const upload = await syncDevice(server, phone);
    assert.deepEqual(upload.rounds.map((round) => [round.clientId, round.inProgress]), [['live-1', true]]);
    assert.deepEqual(phone.data.history, [], 'its own round coming back stays out of history');

    await syncDevice(server, tablet);
    assert.deepEqual(tablet.data.history.map((round) => [round.id, round.inProgress]), [['live-1', true]]);

    // Finishing moves it into history with the same id and a newer edit time.
    phone.data.activeRound = null;
    phone.data.history = [{ ...live, inProgress: undefined, updatedAt: tick() }];
    await syncDevice(server, phone);
    await syncDevice(server, tablet);
    assert.deepEqual(tablet.data.history.map((round) => [round.id, round.inProgress]), [['live-1', undefined]]);
  });

  test('a round abandoned after uploading is deleted from other devices', async () => {
    const token = await server.register('abandon@example.com');
    const phone = newDevice(token);
    const tablet = newDevice(token);
    phone.data.activeRound = session('gone-1', { updatedAt: tick(), inProgress: true });
    await syncDevice(server, phone);
    await syncDevice(server, tablet);
    assert.equal(tablet.data.history.length, 1);
    phone.data.activeRound = null;
    phone.data.deletedRounds = [{ clientId: 'gone-1', updatedAt: tick() }];
    await syncDevice(server, phone);
    await syncDevice(server, tablet);
    assert.deepEqual(tablet.data.history, []);
  });

  test('a deleted round disappears from other devices and its share link stops working', async () => {
    const token = await server.register('delete-round@example.com');
    const phone = newDevice(token, { ...emptyData(), history: [session('round-1', { shared: true, updatedAt: tick() }), session('round-2', { updatedAt: tick() })] });
    await syncDevice(server, phone);
    const shareToken = phone.data.history.find((item) => item.id === 'round-1')!.shareToken;
    assert.equal((await server.request('GET', `/r/${shareToken}`)).status, 200);

    const tablet = newDevice(token);
    await syncDevice(server, tablet);
    assert.equal(tablet.data.history.length, 2);

    // The phone deletes round-1 the way the app does: drop it and remember the deletion.
    phone.data.history = phone.data.history.filter((item) => item.id !== 'round-1');
    phone.data.deletedRounds = [{ clientId: 'round-1', updatedAt: tick() }];
    assert.equal(countPendingChanges(phone.data, phone.account.pushedThrough), 1);
    await syncDevice(server, phone);
    assert.equal(phone.data.deletedRounds.length, 0, 'sent deletions are forgotten');

    await syncDevice(server, tablet);
    assert.deepEqual(tablet.data.history.map((item) => item.id), ['round-2']);
    assert.equal((await server.request('GET', `/r/${shareToken}`)).status, 404);
  });

  test('the newer edit wins when both devices change the same course offline', async () => {
    const token = await server.register('conflict-app@example.com');
    const phone = newDevice(token, { ...emptyData(), courses: [course('course-1', { updatedAt: tick() })] });
    await syncDevice(server, phone);
    const tablet = newDevice(token);
    await syncDevice(server, tablet);

    phone.data.courses = [{ ...phone.data.courses[0], name: 'Phone name', updatedAt: tick() }];
    tablet.data.courses = [{ ...tablet.data.courses[0], name: 'Tablet name (newer)', updatedAt: tick() }];
    await syncDevice(server, tablet);
    await syncDevice(server, phone);
    assert.equal(phone.data.courses[0].name, 'Tablet name (newer)');
  });

  test('sharing a round returns a link token that opens a public page, and publishing a course lists it', async () => {
    const token = await server.register('share-app@example.com', 'Sharer');
    const phone = newDevice(token, {
      ...emptyData(),
      courses: [course('course-1', { name: 'Public Pines', published: true, updatedAt: tick() })],
      history: [session('round-1', { courseName: 'Public Pines', shared: true, updatedAt: tick() })],
    });
    await syncDevice(server, phone);

    const shareToken = phone.data.history[0].shareToken;
    assert.ok(shareToken);
    const page = await server.request('GET', `/r/${shareToken}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /Public Pines/);
    assert.match(page.body, /<span class="total">3<\/span>/, 'OB penalty counted: 2 throws + 1');

    const coursePage = await server.request('GET', `/c/${phone.data.courses[0].uid}`);
    assert.equal(coursePage.status, 200);
    assert.match(coursePage.body, /mapped by Sharer/);

    const search = await server.request('GET', '/api/public/courses?q=pines');
    assert.equal(search.body.courses[0].name, 'Public Pines');
  });

  test('course layouts and the layout a round was played on sync and drive the shared scorecard', async () => {
    const token = await server.register('layouts@example.com', 'Layout Mapper');
    const blueTees = {
      id: 'layout-blue',
      name: 'Blue tees',
      holes: 1,
      layouts: [{ tee: { latitude: 40.0002, longitude: -75, accuracy: 3, timestamp: 5 }, basket: { latitude: 40.001, longitude: -75, accuracy: 3, timestamp: 6 }, par: 4 }],
    };
    const phone = newDevice(token, {
      ...emptyData(),
      courses: [course('course-1', { name: 'Two Layout Park', layoutName: 'Red tees', extraLayouts: [blueTees], published: true, updatedAt: tick() })],
      history: [session('round-blue', { courseName: 'Two Layout Park', layoutId: 'layout-blue', shared: true, updatedAt: tick() })],
    });
    await syncDevice(server, phone);

    const tablet = newDevice(token);
    await syncDevice(server, tablet);
    const synced = tablet.data.courses[0];
    assert.equal(synced.layoutName, 'Red tees');
    assert.equal(synced.extraLayouts?.[0].name, 'Blue tees');
    assert.equal(synced.extraLayouts?.[0].layouts[0].par, 4);
    assert.equal(tablet.data.history[0].layoutId, 'layout-blue');

    // The shared round is scored against the Blue tees par (4), not the main layout's par (3).
    const round = await server.request('GET', `/api/public/rounds/${phone.data.history[0].shareToken}`);
    assert.equal(round.body.round.layoutName, 'Blue tees');
    assert.equal(round.body.round.layouts[0].par, 4);
    const page = await server.request('GET', `/r/${phone.data.history[0].shareToken}`);
    assert.match(page.body, /Blue tees layout/);
    assert.match(page.body, /<span class="par under">-1<\/span>/, '3 strokes on a par 4');

    const detail = await server.request('GET', `/api/public/courses/${synced.uid}`);
    assert.equal(detail.body.course.extraLayouts[0].par, 4);
    const search = await server.request('GET', '/api/public/courses?q=Two%20Layout');
    assert.equal(search.body.courses[0].layoutCount, 2);

    // Deleting the layout leaves the shared round without pars rather than guessing the main layout's.
    phone.data.courses = [{ ...phone.data.courses[0], extraLayouts: [], updatedAt: tick() }];
    await syncDevice(server, phone);
    const orphaned = await server.request('GET', `/api/public/rounds/${phone.data.history[0].shareToken}`);
    assert.deepEqual(orphaned.body.round.layouts, []);
  });

  test('long text is clipped instead of failing the sync', async () => {
    const token = await server.register('long@example.com');
    const phone = newDevice(token, { ...emptyData(), courses: [course('course-1', { notes: 'x'.repeat(9000), name: 'y'.repeat(500), updatedAt: tick() })] });
    await syncDevice(server, phone);
    assert.equal(phone.data.courses[0].uid !== undefined, true);
  });

  test('a history too large for one request uploads in batches and downloads in full', async () => {
    const token = await server.register('prolific@example.com');
    const throws = Array.from({ length: 150 }, (_, index) => ({ x: 0.5, y: 0.5, feet: 200 + index, disc: 'Destroyer', type: 'Drive' as const, hole: 1 + (index % 18), latitude: 40.0001 * index, longitude: -75.0001 * index, altitude: 120.25, lie: 'Fairway' as const, quality: 2, qualityMax: 3 }));
    const history = Array.from({ length: 260 }, (_, index) => session(`big-${index}`, { shots: throws }));
    const phone = newDevice(token, { ...emptyData(), history, bag: ['Destroyer'], bagUpdatedAt: tick() });
    const upload = await syncDevice(server, phone);
    assert.ok(JSON.stringify(upload).length > 5_000_000, 'more than the server takes in one request');
    assert.ok(upload.requests > 1);
    assert.equal(countPendingChanges(phone.data, phone.account.pushedThrough), 0);

    const tablet = newDevice(token);
    const download = await syncDevice(server, tablet);
    assert.ok(download.requests > 1, 'downloaded a page at a time');
    assert.equal(tablet.data.history.length, 260);
    assert.deepEqual(tablet.data.bag, ['Destroyer']);
  });

  test('share pages escape user text and 404 cleanly', async () => {
    const token = await server.register('xss@example.com', '<script>alert(1)</script>');
    const phone = newDevice(token, { ...emptyData(), history: [session('round-x', { courseName: '<img src=x onerror=alert(1)>', shared: true, updatedAt: tick() })] });
    await syncDevice(server, phone);
    const page = await server.request('GET', `/r/${phone.data.history[0].shareToken}`);
    assert.doesNotMatch(page.body, /<script>alert|<img src=x/);
    assert.equal((await server.request('GET', '/r/doesnotexist123')).status, 404);
    assert.equal((await server.request('GET', '/c/not-a-uuid')).status, 404);
  });
});

describe('splitSyncRequest', () => {
  test('keeps every record, puts the bag first, and keeps batches small', () => {
    const history = Array.from({ length: 250 }, (_, index) => session(`round-${index}`, { updatedAt: 5 }));
    const courses = Array.from({ length: 30 }, (_, index) => course(`course-${index}`, { updatedAt: 5 }));
    const request = buildSyncRequest({ ...emptyData(), history, courses, bag: ['Buzzz'], bagUpdatedAt: 5 }, { cursor: 7, pushedThrough: 0 });
    const batches = splitSyncRequest(request);
    assert.equal(batches.length, 3);
    assert.deepEqual(batches.map((batch) => batch.bag !== undefined), [true, false, false]);
    assert.ok(batches.every((batch) => batch.cursor === 7 && batch.courses.length + batch.rounds.length <= 100));
    assert.deepEqual(batches.flatMap((batch) => batch.courses), request.courses);
    assert.deepEqual(batches.flatMap((batch) => batch.rounds), request.rounds);
  });

  test('an empty upload is still one request, to download changes', () => {
    assert.equal(splitSyncRequest({ cursor: 3, courses: [], rounds: [] }).length, 1);
  });
});
