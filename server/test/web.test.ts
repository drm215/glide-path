import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers.ts';

type Server = Awaited<ReturnType<typeof startTestServer>>;

const point = (latitude: number, longitude: number) => ({ latitude, longitude, accuracy: 3, timestamp: 1 });

const pageData = (html: string) => {
  const match = html.match(/<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/);
  assert.ok(match, 'page embeds its data');
  return JSON.parse(match[1]);
};

describe('website', () => {
  let server: Server;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.stop();
  });

  test('serves the static pages with security headers', async () => {
    for (const [path, text] of [['/', 'Courses mapped on the ground'], ['/account', 'Sign in.'], ['/privacy', 'Your data in Glide Path']]) {
      const response = await fetch(`${server.baseUrl}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(await response.text(), new RegExp(text), path);
      const csp = response.headers.get('content-security-policy') ?? '';
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /img-src 'self' data: https:\/\/server\.arcgisonline\.com/);
    }
  });

  test('serves the scripts, map settings, and Leaflet, compressed', async () => {
    const base = server.baseUrl;
    for (const path of ['/js/lib.js', '/js/home.js', '/js/course.js', '/js/round.js', '/js/account.js', '/js/summary.js', '/js/round-stats.js', '/styles.css', '/vendor/leaflet/leaflet.css']) {
      assert.equal((await fetch(`${base}${path}`)).status, 200, path);
    }
    const config = await (await fetch(`${base}/js/config.js`)).text();
    assert.match(config, /window\.GLIDE_PATH_TILES = \{"url":"https:\/\/server\.arcgisonline\.com/);
    const leaflet = await fetch(`${base}/vendor/leaflet/leaflet.js`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(leaflet.status, 200);
    assert.equal(leaflet.headers.get('content-encoding'), 'gzip');
  });

  test('unknown pages get an HTML 404 and unknown API paths a JSON 404', async () => {
    const page = await server.request('GET', '/no-such-page');
    assert.equal(page.status, 404);
    assert.match(page.body, /Not found/);
    const api = await server.request('GET', '/api/no-such-endpoint');
    assert.equal(api.status, 404);
    assert.equal(api.body.error, 'Not found.');
  });

  test('course pages render every layout and embed map data', async () => {
    const token = await server.register('web-course@example.com', 'Web Mapper');
    const synced = await server.request('POST', '/api/sync', {
      token,
      body: {
        courses: [{
          clientId: 'c1', updatedAt: 1, name: 'Web Woods', holes: 1, published: true, layoutName: 'Reds',
          layouts: [{ tee: { ...point(40, -75), altitude: 100 }, basket: { ...point(40.001, -75), altitude: 103 }, par: 3 }],
          extraLayouts: [{ id: 'blue', name: 'Blues', holes: 1, layouts: [{ tee: point(40.0003, -75), basket: point(40.001, -75), par: 4 }] }],
          details: { city: 'Media', state: 'PA', notes: 'Pay at the kiosk', phone: '(555) 123-4567' },
        }],
      },
    });
    const page = await server.request('GET', `/c/${synced.body.courses[0].uid}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Web Woods · Glide Path<\/title>/);
    assert.match(page.body, /property="og:description" content="1 hole · Par 3/);
    assert.match(page.body, /data-layout="1" aria-pressed="false">Blues</);
    assert.match(page.body, /↑ 10 ft/, 'elevation column');
    assert.match(page.body, /Pay at the kiosk/);
    const data = pageData(page.body);
    assert.equal(data.layouts.length, 2);
    assert.equal(data.layouts[1][0].par, 4);
  });

  test('round pages embed throws safely, even with hostile text', async () => {
    const token = await server.register('web-round@example.com', 'Roundsman');
    const hostile = '</script><script>alert(1)</script>';
    const synced = await server.request('POST', '/api/sync', {
      token,
      body: {
        rounds: [{
          clientId: 'r1', updatedAt: 1, courseName: 'Web Woods', mode: 'Round', shared: true,
          shots: [{ hole: 1, feet: 300, disc: hostile, type: 'Drive', lie: 'Basket', latitude: 40.0009, longitude: -75 }],
        }],
      },
    });
    const page = await server.request('GET', `/r/${synced.body.rounds[0].shareToken}`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.body, /<\/script><script>alert/);
    assert.equal(pageData(page.body).shots[0].disc, hostile, 'embedded data round-trips exactly');
    assert.match(page.body, /property="og:description" content="Scored 1 on/);
    assert.match(page.body, /<div id="round-summary"><\/div>/, 'slot for the round summary');
  });
});
