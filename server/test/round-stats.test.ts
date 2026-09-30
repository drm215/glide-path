// Tests the website's round summary figures (public/js/round-stats.js).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
// @ts-expect-error: plain browser JavaScript module without type declarations.
import { summarizeRound } from '../public/js/round-stats.js';

const shot = (type: string, disc: string, feet: number, lie: string, quality?: number, qualityMax = 3) => ({ hole: 1, type, disc, feet, lie, quality, qualityMax });

describe('summarizeRound', () => {
  const shots = [
    shot('Drive', 'Destroyer', 320, 'Fairway', 3),
    shot('Drive', 'Destroyer', 280, 'OB', 1),
    shot('Approach', 'Buzzz', 150, 'Fairway', 2),
    shot('Putt', 'Aviar', 25, 'Missed', 1),
    shot('Putt', 'Aviar', 12, 'Hit basket', 2),
    shot('Putt', 'Aviar', 8, 'Basket', 3),
    // No GPS reference, so no distance; rated on the old 1–5 scale (4/5 ≈ 2/3).
    shot('Drive', 'Destroyer', 0, 'Woods', 4, 5),
  ];
  const summary = summarizeRound(shots);

  test('totals, penalties and the longest throw', () => {
    assert.equal(summary.count, 7);
    assert.equal(summary.penalties, 1);
    assert.equal(summary.totalFeet, 795);
    assert.deepEqual(summary.longest, { feet: 320, disc: 'Destroyer', type: 'Drive' });
    assert.ok(Math.abs(summary.averageQuality - 2) < 0.01);
  });

  test('breaks down by throw type in playing order, ignoring unknown distances', () => {
    assert.deepEqual(summary.byType.map((row: { label: string }) => row.label), ['Drive', 'Approach', 'Putt']);
    const drives = summary.byType[0];
    assert.equal(drives.count, 3);
    assert.equal(drives.averageFeet, 300, 'the throw with no distance is excluded');
    assert.equal(drives.longestFeet, 320);
  });

  test('breaks down by disc, most-thrown first', () => {
    assert.deepEqual(summary.byDisc.map((row: { label: string; count: number }) => [row.label, row.count]), [['Destroyer', 3], ['Aviar', 3], ['Buzzz', 1]]);
  });

  test('putting results, landings and quality', () => {
    // All three putts are on hole 1, so there's one first putt (missed); with no GPS positions
    // or layouts its distance can't be measured.
    assert.deepEqual(summary.putting, { attempts: 3, made: 1, hit: 1, missed: 1, firstPutts: { attempts: 1, made: 0, averageFeet: null, measured: 0 } });
    assert.deepEqual(summary.landings.map((item: { lie: string; count: number }) => [item.lie, item.count]),
      [['Fairway', 2], ['Woods', 1], ['OB', 1], ['Basket', 1], ['Hit basket', 1], ['Missed', 1]]);
    assert.deepEqual(summary.qualities, [{ label: 'Good', count: 2 }, { label: 'Fair', count: 3 }, { label: 'Poor', count: 2 }]);
  });

  test('first putts: make rate and distance from the lie to the basket', () => {
    const at = (latitude: number) => ({ latitude, longitude: -75 });
    // Baskets are 0.001° north of each tee (about 365 ft).
    const holes = [
      { tee: at(40), basket: at(40.001) },
      { tee: at(41), basket: at(41.001) },
      { tee: at(42), basket: null },
      { tee: at(43), basket: at(43.001) },
    ];
    const round = [
      // Hole 1: approach lands about 20 ft short, first putt made.
      { hole: 1, type: 'Drive', disc: 'D', feet: 300, lie: 'Fairway', ...at(40.0008) },
      { hole: 1, type: 'Approach', disc: 'A', feet: 53, lie: 'Fairway', ...at(40.000945) },
      { hole: 1, type: 'Putt', disc: 'P', feet: 20, lie: 'Basket', ...at(40.001) },
      // Hole 2: first putt from about 40 ft missed long; its own travel (55 ft) isn't the putt length.
      { hole: 2, type: 'Drive', disc: 'D', feet: 320, lie: 'Fairway', ...at(41.00089) },
      { hole: 2, type: 'Putt', disc: 'P', feet: 55, lie: 'Missed', ...at(41.00104) },
      { hole: 2, type: 'Putt', disc: 'P', feet: 15, lie: 'Basket', ...at(41.001) },
      // Hole 3: basket not mapped; a made putt falls back to its own distance.
      { hole: 3, type: 'Drive', disc: 'D', feet: 300, lie: 'Fairway', ...at(42.0008) },
      { hole: 3, type: 'Putt', disc: 'P', feet: 30, lie: 'Basket' },
      // Hole 4: no putt at all (an ace), so it isn't a first-putt hole.
      { hole: 4, type: 'Drive', disc: 'D', feet: 365, lie: 'Basket', ...at(43.001) },
    ];
    const { putting } = summarizeRound(round, holes);
    assert.equal(putting.firstPutts.attempts, 3);
    assert.equal(putting.firstPutts.made, 2);
    assert.equal(putting.firstPutts.measured, 3);
    // (20 + 40 + 30) / 3 = 30 ft, within rounding of the coordinates.
    assert.ok(Math.abs(putting.firstPutts.averageFeet - 30) < 1.5, `average first putt was ${putting.firstPutts.averageFeet}`);
    assert.deepEqual([putting.attempts, putting.made], [4, 3]);
  });

  test('a round without putts or ratings', () => {
    const plain = summarizeRound([shot('Drive', 'Leopard', 250, 'Fairway')]);
    assert.equal(plain.putting, null);
    assert.equal(plain.averageQuality, null);
    assert.deepEqual(plain.qualities, []);
  });
});
