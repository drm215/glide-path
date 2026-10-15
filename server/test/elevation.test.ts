import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { createElevationLookup, decodePng } from '../src/elevation.ts';
import { startTestServer } from './helpers.ts';

// A PNG of `pixels` (RGB rows), each row stored with the next of PNG's five filters in turn, so
// the decoder's unfiltering is checked for all of them.
const encodePng = (width: number, rows: number[][]) => {
  const paeth = (left: number, up: number, upLeft: number) => {
    const estimate = left + up - upLeft;
    const [a, b, c] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
    return a <= b && a <= c ? left : b <= c ? up : upLeft;
  };
  const raw = rows.flatMap((row, y) => {
    const filter = y % 5;
    const above = rows[y - 1] ?? [];
    return [filter, ...row.map((value, x) => {
      const left = x >= 3 ? row[x - 3] : 0;
      const up = above[x] ?? 0;
      const upLeft = x >= 3 ? above[x - 3] ?? 0 : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      return (value - predictor + 256) & 0xff;
    })];
  });
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, Buffer.from(type, 'ascii'), body, Buffer.alloc(4)]); // CRC isn't checked
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(rows.length, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]));
};

// Terrarium pixels: metres = red × 256 + green + blue / 256 − 32768.
const terrarium = (metres: number) => {
  const value = metres + 32768;
  return [Math.floor(value / 256), Math.floor(value) % 256, Math.round((value % 1) * 256)];
};

describe('ground elevation', () => {
  test('decodes PNG rows stored with every filter', () => {
    const rows = Array.from({ length: 6 }, (_, y) => Array.from({ length: 4 * 3 }, (_, x) => (x * 37 + y * 91 + x * y * 13) % 256));
    const { width, channels, data } = decodePng(encodePng(4, rows));
    assert.deepEqual([width, channels], [4, 3]);
    assert.deepEqual([...data], rows.flat());
  });

  test('reads elevations from the tile under each point, fetching each tile once', async () => {
    // A 256 × 256 tile rising 1 m per pixel west to east, from 100 m.
    const tile = encodePng(256, Array.from({ length: 256 }, () => Array.from({ length: 256 }, (_, x) => terrarium(100 + x)).flat()));
    const fetched: string[] = [];
    const lookup = createElevationLookup(async (x, y) => {
      fetched.push(`${x}/${y}`);
      if (x === 0) throw new Error('no tile');
      return tile;
    });
    // Near the tile's west edge, a little east of it, and a point whose tile is missing.
    const [west, east, missing] = await lookup([{ latitude: 40.0001, longitude: -74.99998 }, { latitude: 40.0001, longitude: -74.9997 }, { latitude: 40, longitude: -180 }]);
    assert.equal(missing, null);
    assert.ok(west !== null && east !== null && east > west, `${west} < ${east}`);
    assert.equal(east! - west!, Math.round(east! - west!), 'whole pixels apart');
    await lookup([{ latitude: 40.0001, longitude: -74.99998 }]);
    assert.equal(fetched.filter((key) => !key.startsWith('0/')).length, 1, 'the tile is kept');
  });

  describe('the elevations endpoint', () => {
    let server: Awaited<ReturnType<typeof startTestServer>>;
    before(async () => {
      server = await startTestServer({ elevations: async (points) => points.map((point) => point.latitude * 10) });
    });
    after(async () => {
      await server.stop();
    });

    test('answers signed-in accounts, a batch at a time', async () => {
      assert.equal((await server.request('POST', '/api/elevations', { body: { points: [] } })).status, 401);
      const token = await server.register('elevation@example.com');
      const answer = await server.request('POST', '/api/elevations', { token, body: { points: [{ latitude: 40, longitude: -75 }, { latitude: 41.5, longitude: -75 }] } });
      assert.deepEqual(answer.body, { elevations: [400, 415] });
      const tooMany = Array.from({ length: 2001 }, () => ({ latitude: 40, longitude: -75 }));
      assert.equal((await server.request('POST', '/api/elevations', { token, body: { points: tooMany } })).status, 400);
    });
  });
});
