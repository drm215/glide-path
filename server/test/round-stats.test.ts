// Tests the website's round summary figures (public/js/round-stats.js).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
// @ts-expect-error: plain browser JavaScript module without type declarations.
import { holeBreakdown, reliableDistances, roundScore, scoringStats, summarizeRound, summarizeRounds } from '../public/js/round-stats.js';
// @ts-expect-error: plain browser JavaScript module without type declarations.
import { segmentLabels, throwMarkerClass, throwSegments } from '../public/js/lib.js';

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
    assert.deepEqual(summary.putting, {
      attempts: 3, made: 1, hit: 1, missed: 1,
      madePutts: { averageFeet: 8, longestFeet: 8, measured: 1 },
      firstPutts: { attempts: 1, made: 0, averageFeet: null, measured: 0 },
    });
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

  test('distances measured from or to a poor GPS reading are left out of distance figures', () => {
    const at = (latitude: number, accuracy?: number) => ({ latitude, longitude: -75, ...(accuracy === undefined ? {} : { accuracy }) });
    const round = [
      { hole: 1, type: 'Drive', disc: 'D', feet: 300, lie: 'Fairway', ...at(40.0008, 4) },
      // Logged under trees at ±30 m: its own distance is unreliable...
      { hole: 1, type: 'Approach', disc: 'A', feet: 500, lie: 'Fairway', ...at(40.0009, 30) },
      // ...and so is the next one, measured from it.
      { hole: 1, type: 'Approach', disc: 'A', feet: 400, lie: 'Fairway', ...at(40.00095, 5) },
      // Measured from a good lie again; logged before accuracy was saved, so it counts.
      { hole: 1, type: 'Approach', disc: 'A', feet: 40, lie: 'Fairway', ...at(40.00096) },
      // Another hole starts afresh from its tee.
      { hole: 2, type: 'Drive', disc: 'D', feet: 320, lie: 'Fairway', ...at(41.0008, 3) },
    ];
    const summary = summarizeRound(round);
    assert.equal(summary.count, 5, 'every throw still counts');
    assert.equal(summary.totalFeet, 660);
    assert.deepEqual(summary.longest, { feet: 320, disc: 'D', type: 'Drive' });
    const approach = summary.byType.find((row: { label: string }) => row.label === 'Approach');
    assert.deepEqual([approach.count, approach.averageFeet], [3, 40]);
    assert.equal(reliableDistances([{ shots: round }]).size, 3);
  });

  test('first putts and drive circles skip positions with poor GPS accuracy', () => {
    const at = (latitude: number, accuracy?: number) => ({ latitude, longitude: -75, ...(accuracy === undefined ? {} : { accuracy }) });
    const holes = [{ tee: at(40), basket: at(40.001) }, { tee: at(41), basket: at(41.001) }];
    const { putting, driveCircles } = summarizeRound([
      // Hole 1: the drive's fix is poor, so neither the drive nor the putt from there is measured.
      { hole: 1, type: 'Drive', disc: 'D', feet: 350, lie: 'Fairway', ...at(40.00095, 25) },
      { hole: 1, type: 'Putt', disc: 'P', feet: 20, lie: 'Basket', ...at(40.001) },
      // Hole 2: a good fix about 20 ft short; both measured.
      { hole: 2, type: 'Drive', disc: 'D', feet: 345, lie: 'Fairway', ...at(41.001 - 20 / 364_000, 4) },
      { hole: 2, type: 'Putt', disc: 'P', feet: 20, lie: 'Basket', ...at(41.001) },
    ], holes);
    assert.deepEqual(driveCircles, { drives: 2, measured: 1, c1: 1, c2: 0 });
    assert.deepEqual([putting.firstPutts.attempts, putting.firstPutts.made, putting.firstPutts.measured], [2, 2, 1]);
  });

  test("a filtered list of throws keeps the full rounds' judgement of which distances are reliable", () => {
    const round = [
      { hole: 1, type: 'Drive', disc: 'D', feet: 300, lie: 'Fairway', latitude: 40.0008, longitude: -75, accuracy: 40 },
      { hole: 1, type: 'Approach', disc: 'A', feet: 60, lie: 'Fairway', latitude: 40.0009, longitude: -75, accuracy: 3 },
    ];
    const reliable = reliableDistances([{ shots: round }]);
    // On its own the approach looks fine; it was thrown from the poor drive position.
    assert.equal(summarizeRounds([{ shots: [round[1]] }]).byDisc[0].averageFeet, 60);
    assert.equal(summarizeRounds([{ shots: [round[1]] }], reliable).byDisc[0].averageFeet, null);
  });

  test('made putts: average and longest distance from the basket, leaving out unreliable ones', () => {
    const putt = (feet: number, lie: string, accuracy?: number) => ({ hole: 1, type: 'Putt', disc: 'P', feet, lie, latitude: 40, longitude: -75, ...(accuracy === undefined ? {} : { accuracy }) });
    const { putting } = summarizeRound([
      putt(10, 'Basket'),
      putt(30, 'Missed'),
      { ...putt(20, 'Basket'), hole: 2 },
      // Its lie was logged at ±25 m, so the made putt after it isn't measured.
      { hole: 3, type: 'Approach', disc: 'A', feet: 100, lie: 'Fairway', latitude: 40, longitude: -75, accuracy: 25 },
      { ...putt(45, 'Basket'), hole: 3 },
    ]);
    assert.deepEqual(putting.madePutts, { averageFeet: 15, longestFeet: 20, measured: 2 });
    assert.equal(putting.made, 3);
    assert.deepEqual(summarizeRound([putt(30, 'Missed')]).putting.madePutts, { averageFeet: null, longestFeet: null, measured: 0 });
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

describe('distance labels on throw lines', () => {
  test('label drives and approaches at the middle of their line, but not putts', () => {
    const tee = { latitude: 40, longitude: -75 };
    const labels = segmentLabels([
      { type: 'Drive', feet: 300, latitude: 40.0008, longitude: -75 },
      { type: 'Approach', feet: 0, latitude: 40.001, longitude: -75 }, // no stored distance: measured from the line
      { type: 'Approach', feet: 50 }, // no position: no line, no label
      { type: 'Putt', feet: 20, latitude: 40.00105, longitude: -75 },
    ], tee);
    assert.equal(labels.length, 2);
    assert.deepEqual(labels[0], [[40.0004, -75], '300 ft']);
    assert.ok(Math.abs(labels[1][0][0] - 40.0009) < 1e-9);
    assert.equal(labels[1][1], '73 ft');
  });

  test('a first throw with no mapped tee has no line to label', () => {
    assert.deepEqual(segmentLabels([{ type: 'Drive', feet: 300, latitude: 40.0008, longitude: -75 }], null), []);
  });
});

describe('throw line colors', () => {
  test("each line takes its throw's quality color, unrated stays default, OB is dashed", () => {
    const tee = { latitude: 40, longitude: -75 };
    const segments = throwSegments([
      { type: 'Drive', quality: 3, qualityMax: 3, latitude: 40.0005, longitude: -75 },
      { type: 'Approach', quality: 2, qualityMax: 3, latitude: 40.0008, longitude: -75 },
      { type: 'Approach', quality: 1, qualityMax: 3, lie: 'OB', latitude: 40.0009, longitude: -75.0002 },
      { type: 'Putt', latitude: 40.001, longitude: -75 },
    ], tee);
    assert.deepEqual(segments.map((item: { color: string | null; dashed: boolean }) => [item.color, item.dashed]),
      [['#2e9d5b', false], ['#e3b505', false], ['#d64541', true], [null, false]]);
    assert.deepEqual(segments[0].from, tee, 'first line starts at the tee');
    assert.deepEqual(segments[1].from, { latitude: 40.0005, longitude: -75 }, 'later lines start at the previous throw');
  });
});

describe('holeBreakdown and scoringStats', () => {
  const at = (latitude: number) => ({ latitude, longitude: -75 });
  const foot = 1 / 364_000; // about one foot of latitude, in degrees
  // Baskets are 0.001° north of each tee (about 365 ft); hole 3's basket isn't mapped.
  const layouts = [
    { tee: at(40), basket: at(40.001), par: 3 },
    { tee: at(41), basket: at(41.001), par: 4 },
    { tee: at(42), basket: null, par: 3 },
  ];
  const short = (hole: number, feet: number) => at(39 + hole + 0.001 - feet * foot);
  const shots = [
    // Hole 1: parked 20 ft away, then the putt goes in. Birdie.
    { hole: 1, type: 'Drive', disc: 'D', feet: 345, lie: 'Fairway', ...short(1, 20) },
    { hole: 1, type: 'Putt', disc: 'P', feet: 20, lie: 'Basket', ...short(1, 0) },
    // Hole 2: drive into the woods, approach to 50 ft (C2 in regulation), miss, tap in. Par saved.
    { hole: 2, type: 'Drive', disc: 'D', feet: 180, lie: 'Woods', ...short(2, 185) },
    { hole: 2, type: 'Approach', disc: 'A', feet: 135, lie: 'Fairway', ...short(2, 50) },
    { hole: 2, type: 'Putt', disc: 'P', feet: 42, lie: 'Missed', ...short(2, 8) },
    { hole: 2, type: 'Putt', disc: 'P', feet: 8, lie: 'Basket', ...short(2, 0) },
    // Hole 3: OB off the tee, re-tee, then a 30 ft putt into a basket that isn't mapped. Bogey.
    { hole: 3, type: 'Drive', disc: 'D', feet: 0, lie: 'OB' },
    { hole: 3, type: 'Drive', disc: 'D', feet: 0, lie: 'Fairway' },
    { hole: 3, type: 'Putt', disc: 'P', feet: 30, lie: 'Basket' },
  ];
  const holes = holeBreakdown(shots, layouts);
  const near = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) <= 1, `expected about ${expected}, got ${actual}`);

  test('each hole: drive, scramble, green in regulation, putts and the throw in', () => {
    const pick = ({ hole, par, strokes, driving, scramble, green, c1x, c2, penalties }: Record<string, unknown>) => ({ hole, par, strokes, driving, scramble, green, c1x, c2, penalties });
    assert.deepEqual(holes.map(pick), [
      { hole: 1, par: 3, strokes: 2, driving: 'c1', scramble: null, green: 'c1', c1x: { made: 1, attempts: 1 }, c2: { made: 0, attempts: 0 }, penalties: 0 },
      // The 8 ft tap-in is too close to count as a C1X putt.
      { hole: 2, par: 4, strokes: 4, driving: 'rough', scramble: true, green: 'c2', c1x: { made: 0, attempts: 0 }, c2: { made: 0, attempts: 1 }, penalties: 0 },
      // No basket to measure from: the made putt falls back to its own distance, and the green can't be told.
      { hole: 3, par: 3, strokes: 4, driving: 'ob', scramble: false, green: null, c1x: { made: 1, attempts: 1 }, c2: { made: 0, attempts: 0 }, penalties: 1 },
    ]);
    near(holes[0].lengthFeet, 364);
    assert.equal(holes[2].lengthFeet, null);
    near(holes[0].throwInFeet, 20);
    near(holes[1].throwInFeet, 8);
    assert.equal(holes[2].throwInFeet, 30);
  });

  test('scoring percentages across the holes', () => {
    const stats = scoringStats([{ shots, layouts }]);
    assert.deepEqual(
      { holes: stats.holes, fairway: stats.fairway, scramble: stats.scramble, greens: stats.greens, c1x: stats.c1x, c2: stats.c2, penalties: stats.penalties },
      { holes: 3, fairway: { hit: 1, drives: 3 }, scramble: { saved: 1, chances: 2 }, greens: { c1: 1, c2: 2, holes: 2 }, c1x: { made: 2, attempts: 2 }, c2: { made: 0, attempts: 1 }, penalties: 1 },
    );
    assert.equal(stats.madePutts.count, 3);
    near(stats.madePutts.totalFeet, 58);
    near(stats.madePutts.longestFeet, 30);
  });
});

describe('scorecardHtml', () => {
  test('a round longer than nine holes is split into front and back nines, with the total after hole 18', async () => {
    // @ts-expect-error: plain browser JavaScript module without type declarations.
    const { scorecardHtml } = await import('../public/js/scorecard.js');
    const shots = Array.from({ length: 18 }, (_, index) => ({ hole: index + 1, type: 'Drive', disc: 'D', feet: 0, lie: 'Basket' }));
    const html: string = scorecardHtml(shots, []);
    assert.equal(html.match(/<table class="scorecard">/g)?.length, 2);
    assert.equal(html.match(/>Tot</g)?.length, 1);
    const [front, back] = html.split('</table>');
    assert.match(front, /data-hole="9"/);
    assert.doesNotMatch(front, /data-hole="10"/);
    assert.match(back, /data-hole="18">18<\/th><th scope="col" class="total">Tot/);
  });
});

describe('scorecardHtml scramble row', () => {
  test('shows with no scramble chances, as 0/0', async () => {
    // @ts-expect-error: plain browser JavaScript module without type declarations.
    const { scorecardHtml } = await import('../public/js/scorecard.js');
    const html: string = scorecardHtml([{ hole: 1, type: 'Drive', disc: 'D', feet: 300, lie: 'Fairway' }, { hole: 1, type: 'Putt', disc: 'P', feet: 20, lie: 'Basket' }], [{ tee: null, basket: null, par: 3 }]);
    assert.match(html, /Scramble<\/th><td data-hole="1"><\/td><td class="total">0\/0<\/td>/);
  });
});

describe('3D hole view', () => {
  test('a throw arc rises from the lie to a peak and comes back down at the landing spot', async () => {
    // @ts-expect-error: plain browser JavaScript module without type declarations.
    const { arcFeatures } = await import('../public/js/hole3d.js');
    // About 100 m due north.
    const boxes = arcFeatures({ latitude: 40, longitude: -75 }, { latitude: 40.0009, longitude: -75 }, '#2e9d5b');
    const heights = boxes.map((box: { properties: { height: number } }) => box.properties.height);
    assert.ok(boxes.length >= 8);
    assert.ok(heights[0] < 2 && heights.at(-1) < 2, 'starts and ends near the ground');
    const peak = Math.max(...heights);
    assert.ok(peak > 11 && peak < 14, `peaks about an eighth of the distance up (${peak} m)`);
    const peakAt = heights.indexOf(peak) / (heights.length - 1);
    assert.ok(peakAt > 0.4 && peakAt < 0.6, 'peaks mid-throw');
    assert.equal(boxes[0].properties.color, '#2e9d5b');
    assert.deepEqual(arcFeatures({ latitude: 40, longitude: -75 }, { latitude: 40, longitude: -75 }, '#fff'), [], 'no arc for a throw that went nowhere');
  });

  test('throws are joined from the tee; a made throw without a spot goes in the basket; unplaced throws are counted', async () => {
    // @ts-expect-error: plain browser JavaScript module without type declarations.
    const { bearingBetween, holeThrows } = await import('../public/js/hole3d.js');
    const layout = { tee: { latitude: 40, longitude: -75 }, basket: { latitude: 40.001, longitude: -75 }, par: 3 };
    const rounds = [
      { id: 'a', label: 'A', shots: [
        { hole: 1, type: 'Drive', disc: 'D', feet: 300, lie: 'Fairway', latitude: 40.0008, longitude: -75, quality: 3, qualityMax: 3 },
        { hole: 1, type: 'Putt', disc: 'P', feet: 0, lie: 'Basket' },
        { hole: 2, type: 'Drive', disc: 'D', feet: 300, lie: 'Fairway', latitude: 41, longitude: -75 },
      ] },
      { id: 'b', label: 'B', shots: [{ hole: 1, type: 'Drive', disc: 'D', feet: 0, lie: 'Woods' }] },
    ];
    const { arcs, markers, unplaced } = holeThrows(rounds, 1, layout);
    assert.deepEqual(markers.map((item: { number: number; round: { id: string }; shot: { latitude: number } }) => [item.round.id, item.number, item.shot.latitude]), [['a', 1, 40.0008], ['a', 2, 40.001]]);
    assert.equal(unplaced, 1, "round B's drive has no logged spot");
    // Tee to drive, then drive to basket; the good drive is green.
    assert.ok(arcs.some((box: { properties: { color: string } }) => box.properties.color === '#2e9d5b'));
    assert.ok(Math.abs(bearingBetween(layout.tee, layout.basket)) < 0.01, 'due north');
    assert.ok(Math.abs(bearingBetween(layout.tee, { latitude: 40, longitude: -74.999 }) - 90) < 0.01, 'due east');
  });
});

describe('discStats', () => {
  test('percentile interpolates between neighbouring values, like a spreadsheet', async () => {
    // @ts-expect-error: plain browser JavaScript module without type declarations.
    const { percentile } = await import('../public/js/round-stats.js');
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    assert.equal(percentile(values, 0), 100);
    assert.equal(percentile(values, 1), 1000);
    assert.equal(percentile(values, 0.5), 550);
    assert.ok(Math.abs(percentile(values, 0.9) - 910) < 1e-9);
    assert.ok(Math.abs(percentile(values, 0.95) - 955) < 1e-9);
    assert.equal(percentile([250], 0.9), 250);
    assert.equal(percentile([], 0.9), null);
  });

  test("each disc's min, max, average, 90th and 95th percentile and quality, most-thrown first", async () => {
    // @ts-expect-error: plain browser JavaScript module without type declarations.
    const { discStats } = await import('../public/js/round-stats.js');
    const drive = (feet: number, quality?: number) => ({ hole: 1, type: 'Drive', disc: 'Destroyer', feet, lie: 'Fairway', quality, qualityMax: 3 });
    const rounds = [{
      shots: [
        ...[300, 320, 340, 360, 380].map((feet, index) => drive(feet, [3, 3, 2, 1, undefined][index])),
        // No GPS reference: a throw, but no distance.
        drive(0, 2),
        { hole: 2, type: 'Putt', disc: 'Aviar', feet: 20, lie: 'Basket', quality: 3, qualityMax: 3 },
      ],
    }];
    const [destroyer, aviar] = discStats(rounds);
    assert.equal(destroyer.disc, 'Destroyer');
    assert.deepEqual(
      { throws: destroyer.throws, measured: destroyer.measured, min: destroyer.minFeet, max: destroyer.maxFeet, average: destroyer.averageFeet },
      { throws: 6, measured: 5, min: 300, max: 380, average: 340 },
    );
    assert.ok(Math.abs(destroyer.p90Feet - 372) < 1e-9);
    assert.ok(Math.abs(destroyer.p95Feet - 376) < 1e-9);
    assert.deepEqual(destroyer.quality, { good: 2, fair: 2, poor: 1, unrated: 1 });
    assert.equal(destroyer.averageQuality, 2.2);
    assert.equal(aviar.disc, 'Aviar');

    // Limited to putts, only the Aviar is left.
    assert.deepEqual(discStats(rounds, { types: ['Putt'] }).map((item: { disc: string }) => item.disc), ['Aviar']);
  });
});

describe('discThrows', () => {
  test("one disc's throws, longest first, unmeasured last, each with its round", async () => {
    // @ts-expect-error: plain browser JavaScript module without type declarations.
    const { discThrows } = await import('../public/js/round-stats.js');
    const throwOf = (disc: string, type: string, feet: number) => ({ hole: 1, type, disc, feet, lie: 'Fairway' });
    const first = { id: 'first', shots: [throwOf('Buzzz', 'Approach', 180), throwOf('Buzzz', 'Drive', 0), throwOf('Aviar', 'Putt', 20)] };
    const second = { id: 'second', shots: [throwOf('Buzzz', 'Drive', 250), { hole: 1, type: 'Putt', feet: 10, lie: 'Basket', disc: '' }] };
    const rows = (list: { round: { id: string }; shot: { type: string }; feet: number | null }[]) => list.map((item) => [item.round.id, item.shot.type, item.feet]);
    assert.deepEqual(rows(discThrows([first, second], 'Buzzz')), [['second', 'Drive', 250], ['first', 'Approach', 180], ['first', 'Drive', null]]);
    assert.deepEqual(rows(discThrows([first, second], 'Buzzz', { types: ['Drive'] })), [['second', 'Drive', 250], ['first', 'Drive', null]]);
    assert.deepEqual(rows(discThrows([first, second], 'No disc')), [['second', 'Putt', 10]], 'throws without a disc, named as disc stats names them');
  });
});

describe('pars saved with a round', () => {
  test('parsToSave records each played hole, keeps pars already saved, and is undefined with none', async () => {
    // @ts-expect-error: plain browser JavaScript module without type declarations.
    const { parsToSave } = await import('../public/js/round-stats.js');
    const layouts = [{ par: 3 }, { par: 4 }, {}, { par: 5 }];
    assert.deepEqual(parsToSave([{ hole: 1 }, { hole: 2 }, { hole: 3 }], layouts), [3, 4, null]);
    // Hole 4 wasn't played, so its par isn't recorded.
    assert.deepEqual(parsToSave([{ hole: 1 }], layouts), [3]);
    // A resumed round keeps hole 1's saved par though the course now says 3.
    assert.deepEqual(parsToSave([{ hole: 1 }, { hole: 2 }], layouts, [4]), [4, 4]);
    assert.equal(parsToSave([{ hole: 3 }], layouts), undefined);
  });

  test('roundLayouts puts saved pars over the course, keeping its tees and baskets', async () => {
    // @ts-expect-error: plain browser JavaScript module without type declarations.
    const { roundLayouts, roundScore } = await import('../public/js/round-stats.js');
    const tee = { latitude: 40, longitude: -75 };
    const course = [{ tee, basket: null, par: 3 }, { tee: null, basket: null, par: 3 }];
    const layouts = roundLayouts(course, [4, null, 3]);
    assert.deepEqual(layouts, [{ tee, basket: null, par: 4 }, course[1], { tee: null, basket: null, par: 3 }]);
    assert.equal(roundLayouts(course, undefined), course, 'rounds without saved pars use the course');
    // Scored against the saved par (4), not the course's (3).
    assert.equal(roundScore([{ hole: 1, lie: 'Fairway' }, { hole: 1, lie: 'Basket' }], layouts).toPar, -2);
  });
});
