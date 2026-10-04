import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers.ts';

type Server = Awaited<ReturnType<typeof startTestServer>>;

const point = (latitude: number, longitude: number) => ({ latitude, longitude, accuracy: 4, timestamp: 1, altitude: 100 });

const course = (overrides: Record<string, unknown> = {}) => ({
  clientId: '1700000000000',
  updatedAt: 1000,
  name: 'Cedar Grove',
  holes: 2,
  layouts: [
    { tee: point(40.0, -75.0), basket: point(40.001, -75.0), par: 3 },
    { tee: point(40.002, -75.0), basket: null, par: 4 },
  ],
  details: { city: 'Media', state: 'pa', notes: 'Pay at the kiosk' },
  published: false,
  ...overrides,
});

const round = (overrides: Record<string, unknown> = {}) => ({
  clientId: '1700000005000',
  updatedAt: 2000,
  courseClientId: '1700000000000',
  courseName: 'Cedar Grove',
  mode: 'Round',
  shots: [
    { hole: 1, feet: 280, disc: 'Destroyer', type: 'Drive', lie: 'Fairway', quality: 3, latitude: 40.0008, longitude: -75.0 },
    { hole: 1, feet: 20, disc: 'Aviar', type: 'Putt', lie: 'Basket', quality: 3 },
  ],
  shared: false,
  ...overrides,
});

describe('Glide Path API', () => {
  let server: Server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.stop();
  });

  test('health check responds', async () => {
    const response = await server.request('GET', '/healthz');
    assert.equal(response.status, 200);
  });

  describe('accounts', () => {
    test('registers, rejects duplicates case-insensitively, and logs in', async () => {
      const created = await server.request('POST', '/api/auth/register', { body: { email: 'Pat@Example.com', password: 'long enough', displayName: 'Pat' } });
      assert.equal(created.status, 201);
      assert.equal(created.body.user.email, 'pat@example.com');

      const duplicate = await server.request('POST', '/api/auth/register', { body: { email: 'pat@example.com', password: 'long enough', displayName: 'Pat' } });
      assert.equal(duplicate.status, 409);

      const wrongPassword = await server.request('POST', '/api/auth/login', { body: { email: 'pat@example.com', password: 'nope nope' } });
      assert.equal(wrongPassword.status, 401);

      const login = await server.request('POST', '/api/auth/login', { body: { email: 'PAT@example.com', password: 'long enough' } });
      assert.equal(login.status, 200);
      const me = await server.request('GET', '/api/me', { token: login.body.token });
      assert.equal(me.body.user.displayName, 'Pat');
    });

    test('rejects short passwords and bad tokens', async () => {
      const short = await server.request('POST', '/api/auth/register', { body: { email: 'short@example.com', password: 'abc', displayName: 'S' } });
      assert.equal(short.status, 400);
      const badToken = await server.request('GET', '/api/me', { token: 'not-a-token' });
      assert.equal(badToken.status, 401);
      const noToken = await server.request('POST', '/api/sync', { body: {} });
      assert.equal(noToken.status, 401);
    });

    test('deleting an account removes its data', async () => {
      const token = await server.register('gone@example.com');
      await server.request('POST', '/api/sync', { token, body: { courses: [course({ published: true, name: 'Vanishing Park' })] } });
      assert.equal((await server.request('GET', '/api/public/courses?q=Vanishing')).body.courses.length, 1);
      assert.equal((await server.request('DELETE', '/api/me', { token })).status, 204);
      assert.equal((await server.request('GET', '/api/public/courses?q=Vanishing')).body.courses.length, 0);
      assert.equal((await server.request('POST', '/api/sync', { token, body: { courses: [] } })).status, 401, 'its token no longer works');
    });
  });

  describe('sync', () => {
    test('uploads records and downloads them on another device', async () => {
      const token = await server.register('sync@example.com');
      const bag = { updatedAt: 500, discs: ['Buzzz'], details: { Buzzz: { brand: 'Discraft' } } };
      const first = await server.request('POST', '/api/sync', { token, body: { cursor: 0, courses: [course()], rounds: [round()], bag } });
      assert.equal(first.status, 200);
      assert.ok(first.body.cursor > 0);
      assert.equal(first.body.courses[0].name, 'Cedar Grove');
      assert.ok(first.body.courses[0].uid);

      // A fresh device with cursor 0 gets everything.
      const fresh = await server.request('POST', '/api/sync', { token, body: { cursor: 0 } });
      assert.equal(fresh.body.courses.length, 1);
      assert.equal(fresh.body.rounds[0].shots.length, 2);
      assert.equal(fresh.body.rounds[0].shots[0].lie, 'Fairway', 'extra shot fields are kept');
      assert.deepEqual(fresh.body.bag.discs, ['Buzzz']);

      // Nothing new since the latest cursor.
      const caughtUp = await server.request('POST', '/api/sync', { token, body: { cursor: first.body.cursor } });
      assert.equal(caughtUp.body.courses.length, 0);
      assert.equal(caughtUp.body.rounds.length, 0);
      assert.equal(caughtUp.body.bag, null);
      assert.equal(caughtUp.body.cursor, first.body.cursor);
    });

    test('keeps the newest edit when devices conflict', async () => {
      const token = await server.register('conflict@example.com');
      await server.request('POST', '/api/sync', { token, body: { courses: [course({ updatedAt: 5000, name: 'Newer name' })] } });
      const stale = await server.request('POST', '/api/sync', { token, body: { courses: [course({ updatedAt: 4000, name: 'Older name' })] } });
      assert.equal(stale.body.courses[0].name, 'Newer name');

      const newer = await server.request('POST', '/api/sync', { token, body: { courses: [course({ updatedAt: 6000, name: 'Newest name' })] } });
      assert.equal(newer.body.courses[0].name, 'Newest name');
    });

    test('syncs deletions as tombstones', async () => {
      const token = await server.register('tombstone@example.com');
      const first = await server.request('POST', '/api/sync', { token, body: { rounds: [round()] } });
      const deleted = await server.request('POST', '/api/sync', { token, body: { cursor: first.body.cursor, rounds: [round({ updatedAt: 9000, deleted: true })] } });
      assert.equal(deleted.body.rounds.length, 1);
      assert.equal(deleted.body.rounds[0].deleted, true);
    });

    test("keeps each user's data separate even with matching client ids", async () => {
      const alice = await server.register('alice@example.com');
      const bob = await server.register('bob@example.com');
      await server.request('POST', '/api/sync', { token: alice, body: { courses: [course({ name: "Alice's course" })] } });
      await server.request('POST', '/api/sync', { token: bob, body: { courses: [course({ name: "Bob's course" })] } });
      const aliceView = await server.request('POST', '/api/sync', { token: alice, body: { cursor: 0 } });
      assert.deepEqual(aliceView.body.courses.map((item: { name: string }) => item.name), ["Alice's course"]);
    });

    test('rejects malformed records', async () => {
      const token = await server.register('invalid@example.com');
      const response = await server.request('POST', '/api/sync', { token, body: { courses: [course({ holes: 0 })] } });
      assert.equal(response.status, 400);
      assert.ok(response.body.issues.length > 0);
    });
  });

  describe('public courses', () => {
    test('lists only published courses, with search, distance, and totals', async () => {
      const token = await server.register('mapper@example.com', 'Course Mapper');
      await server.request('POST', '/api/sync', {
        token,
        body: {
          courses: [
            course({ clientId: 'a', name: 'Published Park', published: true }),
            course({ clientId: 'b', name: 'Private Park', published: false }),
            course({ clientId: 'c', name: 'Faraway Woods', published: true, layouts: [{ tee: point(34.0, -118.0), basket: point(34.001, -118.0), par: 3 }], details: { city: 'Los Angeles', state: 'CA' } }),
          ],
        },
      });

      const search = await server.request('GET', '/api/public/courses?q=park');
      const names = search.body.courses.map((item: { name: string }) => item.name);
      assert.ok(names.includes('Published Park'));
      assert.ok(!names.includes('Private Park'));

      const published = search.body.courses.find((item: { name: string }) => item.name === 'Published Park');
      assert.equal(published.mappedBy, 'Course Mapper');
      assert.equal(published.state, 'PA');
      assert.equal(published.par, 7);
      assert.equal(published.mappedHoles, 1);
      assert.ok(Math.abs(published.distanceFeet - 365) < 5, `distance was ${published.distanceFeet}`);

      const nearby = await server.request('GET', '/api/public/courses?near=40.0,-75.0&limit=100');
      const nearbyNames = nearby.body.courses.map((item: { name: string }) => item.name);
      assert.ok(nearbyNames.indexOf('Published Park') < nearbyNames.indexOf('Faraway Woods'));

      const detail = await server.request('GET', `/api/public/courses/${published.uid}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.course.details.notes, 'Pay at the kiosk');
      assert.equal(detail.body.course.layouts.length, 2);
    });

    test('hides unpublished and unknown courses', async () => {
      const token = await server.register('hidden@example.com');
      const synced = await server.request('POST', '/api/sync', { token, body: { courses: [course({ published: false })] } });
      assert.equal((await server.request('GET', `/api/public/courses/${synced.body.courses[0].uid}`)).status, 404);
      assert.equal((await server.request('GET', '/api/public/courses/not-a-uuid')).status, 404);
    });

    test('escapes search wildcards', async () => {
      const response = await server.request('GET', '/api/public/courses?q=%25');
      assert.equal(response.status, 200);
      assert.equal(response.body.courses.length, 0);
    });
  });

  describe('shared rounds', () => {
    test('shares a round by token, keeps the token stable, and revokes it', async () => {
      const token = await server.register('sharer@example.com', 'Sharer');
      const shared = await server.request('POST', '/api/sync', { token, body: { courses: [course()], rounds: [round({ shared: true })] } });
      const shareToken = shared.body.rounds[0].shareToken;
      assert.ok(shareToken);

      const view = await server.request('GET', `/api/public/rounds/${shareToken}`);
      assert.equal(view.status, 200);
      assert.equal(view.body.round.playedBy, 'Sharer');
      assert.equal(view.body.round.layouts.length, 2);
      assert.equal(view.body.round.courseUid, null, 'unpublished course is not linked');

      const edited = await server.request('POST', '/api/sync', { token, body: { rounds: [round({ shared: true, updatedAt: 3000 })] } });
      assert.equal(edited.body.rounds[0].shareToken, shareToken, 'token survives edits');

      await server.request('POST', '/api/sync', { token, body: { rounds: [round({ shared: false, updatedAt: 4000 })] } });
      assert.equal((await server.request('GET', `/api/public/rounds/${shareToken}`)).status, 404);
    });

    test('unshared rounds have no token', async () => {
      const token = await server.register('private@example.com');
      const synced = await server.request('POST', '/api/sync', { token, body: { rounds: [round()] } });
      assert.equal(synced.body.rounds[0].shareToken, null);
    });
  });
});
