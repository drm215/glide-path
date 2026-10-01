// Runs the website's page scripts against a simulated browser (linkedom) and checks what they
// actually display. Leaflet isn't loaded here, so pages render without their maps.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { parseHTML } from 'linkedom';
import { startTestServer } from './helpers.ts';

type FetchHandler = (path: string, init?: { method?: string; body?: string }) => unknown;

// The page stubs replace fetch; tests that talk to the real test server need it back.
const realFetch = globalThis.fetch;
let importCount = 0;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// Installs a page as the global document and runs its module script.
const loadPage = async (html: string, script: string, { hash = '', token = null as string | null, api = (() => ({})) as FetchHandler } = {}) => {
  const { window, document } = parseHTML(html);
  const stored = new Map<string, string>(token ? [['glide-path-token', token]] : []);
  const location = { hash, pathname: '/account' };
  Object.assign(window, { scrollTo: () => {}, GLIDE_PATH_TILES: undefined });
  Object.assign(globalThis, {
    window, document, location,
    Node: window.Node,
    history: { replaceState: () => { location.hash = ''; } },
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
    fetch: async (path: string, init?: { method?: string; body?: string }) => {
      const data = api(path, init);
      return { ok: true, status: 200, json: async () => data };
    },
  });
  await import(`../public/js/${script}?run=${++importCount}`);
  await settle();
  const navigate = async (nextHash: string) => {
    location.hash = nextHash;
    window.dispatchEvent(new window.Event('hashchange'));
    await settle();
  };
  return { document, navigate };
};

// Text that means an object or an empty value was rendered as text instead of an element.
const assertNoRenderingLeaks = (text: string) => {
  assert.doesNotMatch(text, /\[object /, 'an element was rendered as text');
  assert.doesNotMatch(text, /\bnull\b|\bundefined\b/, 'an empty value was rendered as text');
};

const point = (latitude: number, longitude: number) => ({ latitude, longitude, accuracy: 3, timestamp: 1 });

const syncedData = {
  cursor: 5,
  courses: [{
    clientId: 'c1', uid: 'u1', updatedAt: 1, name: 'Cedar Grove', holes: 2, published: false, details: { city: 'Media', state: 'PA' },
    layouts: [{ tee: point(40, -75), basket: point(40.001, -75), par: 3 }, { tee: null, basket: null, par: 4 }],
    extraLayouts: [{ id: 'blue', name: 'Blue tees', holes: 1, layouts: [{ tee: point(40.0002, -75), basket: point(40.001, -75), par: 4 }] }],
  }],
  rounds: [{
    clientId: '1790804819013', updatedAt: 2, courseClientId: 'c1', courseName: 'Cedar Grove', mode: 'Round', shared: false, shareToken: null,
    shots: [
      { hole: 1, feet: 300, disc: 'Destroyer', type: 'Drive', style: 'Forehand', lie: 'Fairway', quality: 3, qualityMax: 3 },
      { hole: 1, feet: 60, disc: 'Aviar', type: 'Putt', lie: 'Basket', quality: 3, qualityMax: 3 },
      { hole: 2, feet: 280, disc: 'Destroyer', type: 'Drive', lie: 'OB', quality: 1, qualityMax: 3 },
      { hole: 2, feet: 30, disc: 'Aviar', type: 'Putt', lie: 'Missed', quality: 2, qualityMax: 3 },
    ],
  }],
  bag: { updatedAt: 1, discs: ['Destroyer', 'Aviar'], details: {}, weights: {} },
};
// A practice session somewhere else, for the all-time stats filters.
syncedData.rounds.push({
  clientId: '1790900000000', updatedAt: 3, courseClientId: undefined as unknown as string, courseName: 'Back Yard', mode: 'Practice', shared: false, shareToken: null,
  shots: [{ hole: 1, feet: 40, disc: 'Aviar', type: 'Putt', lie: 'Basket', quality: 3, qualityMax: 3 }],
});

const accountApi: FetchHandler = (path) => (path === '/api/me'
  ? { user: { id: 'x', email: 'pat@example.com', displayName: 'Pat' } }
  : syncedData);

describe('website pages in a browser', () => {
  const accountHtml = readFileSync(new URL('../public/account.html', import.meta.url), 'utf8');

  test('My rounds: signed out shows the sign-in form', async () => {
    const { document } = await loadPage(accountHtml, 'account.js');
    assert.equal(document.getElementById('signed-out')!.hidden, false);
    assert.equal(document.getElementById('signed-in')!.hidden, true);
  });

  test('My rounds: overview lists rounds and courses', async () => {
    const { document } = await loadPage(accountHtml, 'account.js', { token: 't', api: accountApi });
    const text = document.getElementById('signed-in')!.textContent ?? '';
    assert.match(text, /Pat/);
    assert.match(text, /Cedar Grove/);
    assert.match(text, /2 layouts · Private/);
    assertNoRenderingLeaks(text);
  });

  test('My rounds: a round shows its scorecard, summary and throw-by-throw list', async () => {
    const { document } = await loadPage(accountHtml, 'account.js', { token: 't', api: accountApi, hash: '#round/1790804819013' });
    const view = document.getElementById('signed-in')!;
    const text = view.textContent ?? '';
    assertNoRenderingLeaks(text);
    assert.match(text, /Throw by throw/);
    assert.equal(view.querySelectorAll('h3').length >= 2, true);
    assert.match(text, /Hole 01/);
    assert.match(text, /300 ft · Destroyer forehand drive · fairway · 3\/3/);
    assert.match(text, /By throw style/);
    assert.equal(view.querySelectorAll('ol.throws li').length, 4);
    assert.match(text, /Round summary/);
    assert.match(text, /FIRST-PUTT MAKES50%1 of 2 holes/);
    assert.match(text, /ALL PUTTS50%1 of 2 made/);
    // Score: hole 1 = 2 strokes (par 3), hole 2 = 2 throws + 1 OB penalty (par 4).
    assert.match(view.querySelector('.score')!.textContent ?? '', /5-2/);
  });

  test('My rounds: the By disc table filters by throw type and quality', async () => {
    const { document } = await loadPage(accountHtml, 'account.js', { token: 't', api: accountApi, hash: '#round/1790804819013' });
    const breakdown = document.querySelector('.disc-breakdown')!;
    const discRows = () => [...breakdown.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].slice(0, 2).map((cell) => cell.textContent).join(':'));
    const press = (group: string, label: string) => {
      const button = [...breakdown.querySelectorAll(`[aria-label="${group}"] button`)].find((item) => item.textContent === label)!;
      button.dispatchEvent(new (globalThis as unknown as { window: { Event: typeof Event } }).window.Event('click'));
      return button;
    };
    assert.deepEqual(discRows(), ['Destroyer:2', 'Aviar:2']);

    const putt = press('Filter by throw type', 'Putt');
    assert.equal(putt.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(discRows(), ['Aviar:2']);

    press('Filter by throw quality', 'Good');
    assert.deepEqual(discRows(), ['Aviar:1'], 'filters combine');

    press('Filter by throw type', 'Drive');
    assert.deepEqual(discRows(), ['Destroyer:1']);

    press('Filter by throw quality', 'Fair');
    assert.equal(breakdown.querySelector('table'), null);
    assert.match(breakdown.textContent ?? '', /No throws match these filters/);

    press('Filter by throw type', 'All throws');
    press('Filter by throw quality', 'Any quality');
    assert.deepEqual(discRows(), ['Destroyer:2', 'Aviar:2']);
    assertNoRenderingLeaks(breakdown.textContent ?? '');
  });

  test('My rounds: all-time stats, filtered by course and practice', async () => {
    const { document, navigate } = await loadPage(accountHtml, 'account.js', { token: 't', api: accountApi });
    assert.ok(document.querySelector('a[href="#stats"]'), 'overview links to all-time stats');
    await navigate('#stats');
    const view = document.getElementById('signed-in')!;
    const options = () => [...document.querySelectorAll('#stats-course option')].map((option) => option.textContent);
    const tile = (label: string) => [...view.querySelectorAll('.stat')].find((item) => item.querySelector('.label')?.textContent === label)?.querySelector('.value')?.textContent;
    assertNoRenderingLeaks(view.textContent ?? '');
    assert.match(view.textContent ?? '', /All-time stats/);
    assert.match(view.textContent ?? '', /Throw stats/);
    // Practice is excluded by default: one round at one course.
    assert.deepEqual(options(), ['All courses (1)', 'Cedar Grove (1)']);
    assert.equal(tile('ROUNDS'), '1');
    assert.equal(tile('BEST ROUND'), '-2', 'scored against the main layout pars (3 + 4)');

    const practice = document.getElementById('stats-practice') as unknown as { checked: boolean; dispatchEvent: (event: Event) => void };
    practice.checked = true;
    practice.dispatchEvent(new (globalThis as unknown as { window: { Event: typeof Event } }).window.Event('change'));
    // Most-played first; ties alphabetical.
    assert.deepEqual(options(), ['All courses (2)', 'Back Yard (1)', 'Cedar Grove (1)']);
    assert.match(view.textContent ?? '', /By course/);

    const select = document.getElementById('stats-course')!;
    for (const option of select.querySelectorAll('option')) option.toggleAttribute('selected', option.getAttribute('value') === 'name:Back Yard');
    select.dispatchEvent(new (globalThis as unknown as { window: { Event: typeof Event } }).window.Event('change'));
    assert.doesNotMatch(view.textContent ?? '', /By course/);
    assert.match(view.querySelector('.round-summary')?.textContent ?? '', /THROWS1/);
    assertNoRenderingLeaks(view.textContent ?? '');
  });

  test('My rounds: a course shows each layout without leaking text', async () => {
    const { document, navigate } = await loadPage(accountHtml, 'account.js', { token: 't', api: accountApi });
    await navigate('#course/c1');
    const view = document.getElementById('signed-in')!;
    const text = view.textContent ?? '';
    assertNoRenderingLeaks(text);
    assert.match(text, /Blue tees layout/);
    assert.equal(view.querySelectorAll('section[data-layout-panel]').length, 2);
    assert.match(text, /365 ft/);
  });

  describe('shared round page', () => {
    let server: Awaited<ReturnType<typeof startTestServer>>;
    before(async () => {
      server = await startTestServer();
    });
    after(async () => {
      await server.stop();
    });

    test('adds the round summary from the embedded data', async () => {
      globalThis.fetch = realFetch;
      const token = await server.register('dom@example.com', 'Dom');
      const synced = await server.request('POST', '/api/sync', { token, body: { rounds: [{ ...syncedData.rounds[0], shared: true }] } });
      const page = await server.request('GET', `/r/${synced.body.rounds[0].shareToken}`);
      const { document } = await loadPage(page.body, 'round.js');
      const summary = document.querySelector('.round-summary');
      assert.ok(summary, 'summary replaced its placeholder');
      assert.equal(document.getElementById('round-summary'), null);
      const text = summary!.textContent ?? '';
      assertNoRenderingLeaks(text);
      assert.match(text, /1 OB penalty/);
      assert.match(text, /Destroyer/);
    });
  });
});
