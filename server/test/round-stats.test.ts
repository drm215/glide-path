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
    assert.deepEqual(summary.putting, { attempts: 3, made: 1, hit: 1, missed: 1 });
    assert.deepEqual(summary.landings.map((item: { lie: string; count: number }) => [item.lie, item.count]),
      [['Fairway', 2], ['Woods', 1], ['OB', 1], ['Basket', 1], ['Hit basket', 1], ['Missed', 1]]);
    assert.deepEqual(summary.qualities, [{ label: 'Good', count: 2 }, { label: 'Fair', count: 3 }, { label: 'Poor', count: 2 }]);
  });

  test('a round without putts or ratings', () => {
    const plain = summarizeRound([shot('Drive', 'Leopard', 250, 'Fairway')]);
    assert.equal(plain.putting, null);
    assert.equal(plain.averageQuality, null);
    assert.deepEqual(plain.qualities, []);
  });
});
