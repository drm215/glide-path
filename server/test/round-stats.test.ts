// Tests the website's round summary figures (public/js/round-stats.js).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
// @ts-expect-error: plain browser JavaScript module without type declarations.
import { roundScore, summarizeRound, summarizeRounds } from '../public/js/round-stats.js';
// @ts-expect-error: plain browser JavaScript module without type declarations.
import { throwMarkerClass } from '../public/js/lib.js';

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

  test('drives in C1 and C2, measured from the landing spot to the basket', () => {
    const at = (latitude: number) => ({ latitude, longitude: -75 });
    const foot = 1 / 364_000; // about one foot of latitude, in degrees
    const holes = [1, 2, 3, 4, 5, 6].map((hole) => ({ tee: at(40 + hole), basket: at(40 + hole + 0.001) }));
    holes.push({ tee: at(47), basket: null as unknown as ReturnType<typeof at> });
    const drive = (hole: number, feetShort: number | null, lie = 'Fairway') => ({
      hole, type: 'Drive', disc: 'D', feet: 300, lie, ...(feetShort === null ? {} : at(40 + hole + 0.001 - feetShort * foot)),
    });
    const { driveCircles } = summarizeRound([
      drive(1, 20), // C1
      drive(2, 32), // C1 (just inside 32.8 ft)
      drive(3, 50), // C2
      drive(4, 90), // outside
      drive(5, 10, 'OB'), // close, but out of bounds
      { hole: 6, type: 'Drive', disc: 'D', feet: 365, lie: 'Basket' }, // ace with no logged position
      drive(7, 5), // basket not mapped: not measurable
      { hole: 1, type: 'Approach', disc: 'A', feet: 20, lie: 'Fairway', ...at(41.001) }, // approaches don't count
    ], holes);
    assert.deepEqual(driveCircles, { drives: 7, measured: 6, c1: 3, c2: 1 });
  });

  test('breaks down by throw style, most-used first, skipping throws without one', () => {
    const { byStyle } = summarizeRound([
      { hole: 1, type: 'Drive', style: 'Forehand', disc: 'D', feet: 300, lie: 'Fairway' },
      { hole: 2, type: 'Drive', style: 'Backhand', disc: 'D', feet: 320, lie: 'Fairway' },
      { hole: 3, type: 'Drive', style: 'Backhand', disc: 'D', feet: 340, lie: 'Fairway' },
      { hole: 3, type: 'Approach', disc: 'A', feet: 50, lie: 'Fairway' },
    ]);
    assert.deepEqual(byStyle.map((row: { label: string; count: number; averageFeet: number }) => [row.label, row.count, row.averageFeet]), [['Backhand', 2, 330], ['Forehand', 1, 300]]);
  });

  test('combines rounds, measuring each against its own layout', () => {
    const at = (latitude: number) => ({ latitude, longitude: -75 });
    // Same hole number, different courses: each drive is 20 ft short of its own basket.
    const roundA = { shots: [{ hole: 1, type: 'Drive', disc: 'D', feet: 345, lie: 'Fairway', ...at(40.001 - 20 / 364_000) }], layouts: [{ tee: at(40), basket: at(40.001), par: 3 }] };
    const roundB = { shots: [{ hole: 1, type: 'Drive', disc: 'D', feet: 345, lie: 'Fairway', ...at(50.001 - 20 / 364_000) }], layouts: [{ tee: at(50), basket: at(50.001), par: 3 }] };
    const combined = summarizeRounds([roundA, roundB]);
    assert.equal(combined.count, 2);
    assert.deepEqual(combined.driveCircles, { drives: 2, measured: 2, c1: 2, c2: 0 });
    assert.deepEqual(summarizeRound(roundA.shots, roundA.layouts).driveCircles, { drives: 1, measured: 1, c1: 1, c2: 0 });
  });

  test('roundScore counts OB penalties and scores to par only over holes with a par', () => {
    const shots = [
      { hole: 1, type: 'Drive', lie: 'OB' }, { hole: 1, type: 'Drive', lie: 'Fairway' }, { hole: 1, type: 'Putt', lie: 'Basket' },
      { hole: 2, type: 'Drive', lie: 'Basket' },
    ];
    assert.deepEqual(roundScore(shots, [{ par: 3 }, {}]), { holes: 2, strokes: 5, toPar: 1 });
    assert.deepEqual(roundScore(shots, []), { holes: 2, strokes: 5, toPar: null });
  });

  test('a round without putts or ratings', () => {
    const plain = summarizeRound([shot('Drive', 'Leopard', 250, 'Fairway')]);
    assert.equal(plain.putting, null);
    assert.equal(plain.averageQuality, null);
    assert.deepEqual(plain.qualities, []);
  });
});

describe('throw marker colors', () => {
  test('follow quality, keep unrated throws plain, and outline OB throws', () => {
    assert.equal(throwMarkerClass({ quality: 3, qualityMax: 3 }), 'throw-marker good');
    assert.equal(throwMarkerClass({ quality: 2, qualityMax: 3 }), 'throw-marker fair');
    assert.equal(throwMarkerClass({ quality: 1, qualityMax: 3, lie: 'OB' }), 'throw-marker poor ob');
    assert.equal(throwMarkerClass({ quality: 5 }), 'throw-marker good', 'old 1-5 scale');
    assert.equal(throwMarkerClass({ lie: 'Fairway' }), 'throw-marker');
  });
});
