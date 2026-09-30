// Tests the app's round helpers (lib/rounds.ts).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { placeMadeThrowsAtBasket, remeasureHole } from '../../lib/rounds.ts';
import type { HoleLayout, Shot } from '../../lib/types.ts';

const point = (latitude: number, longitude: number) => ({ latitude, longitude, accuracy: 3, timestamp: 1 });
const shot = (hole: number, lie: Shot['lie'], latitude?: number, longitude?: number, feet = 0): Shot =>
  ({ x: 0.5, y: 0.5, feet, disc: 'Aviar', type: 'Putt', hole, lie, latitude, longitude });

// Hole 1 runs due north: 0.001° of latitude is about 365 ft.
const layouts: HoleLayout[] = [
  { tee: point(40, -75), basket: point(40.001, -75), par: 3 },
  { tee: point(40.002, -75), basket: null },
];

describe('placeMadeThrowsAtBasket', () => {
  test('moves a made throw to the basket and remeasures it from the previous lie', () => {
    const shots = [
      shot(1, 'Fairway', 40.0008, -75, 292),
      // Logged 30 ft past the basket, where the player happened to be standing.
      shot(1, 'Basket', 40.00108, -75, 102),
    ];
    const fixed = placeMadeThrowsAtBasket(shots, layouts);
    assert.equal(fixed[1].latitude, 40.001);
    assert.equal(fixed[1].longitude, -75);
    assert.ok(Math.abs(fixed[1].feet - 73) <= 1, `putt distance was ${fixed[1].feet}`);
    assert.equal(fixed[0], shots[0], 'earlier throws are untouched');
  });

  test('measures a hole-in-one from the tee', () => {
    const fixed = placeMadeThrowsAtBasket([shot(1, 'Basket', 40.0012, -75, 438)], layouts);
    assert.ok(Math.abs(fixed[0].feet - 365) <= 1, `ace distance was ${fixed[0].feet}`);
  });

  test('returns the same array when there is nothing to fix', () => {
    const alreadyAtBasket = [shot(1, 'Fairway', 40.0008, -75, 292), shot(1, 'Basket', 40.001, -75, 73)];
    assert.equal(placeMadeThrowsAtBasket(alreadyAtBasket, layouts), alreadyAtBasket);
    const missed = [shot(1, 'Missed', 40.0011, -75, 110)];
    assert.equal(placeMadeThrowsAtBasket(missed, layouts), missed);
    assert.equal(placeMadeThrowsAtBasket(missed, undefined), missed, 'course deleted');
  });

  test('leaves made throws alone when the basket was never mapped', () => {
    const shots = [shot(2, 'Basket', 40.0025, -75, 180)];
    assert.equal(placeMadeThrowsAtBasket(shots, layouts), shots);
  });
});

describe('remeasureHole', () => {
  test('measures each positioned throw from the one before, skipping throws without a position', () => {
    const shots = [shot(1, 'Fairway', 40.0005, -75, 0), shot(1, 'Other', undefined, undefined, 50), shot(1, 'Basket', 40.001, -75, 0)];
    const measured = remeasureHole(shots, 1, layouts[0].tee);
    assert.ok(Math.abs(measured[0].feet - 183) <= 1);
    assert.equal(measured[1].feet, 50);
    assert.ok(Math.abs(measured[2].feet - 183) <= 1);
  });
});
