// Tests the app's round helpers (lib/rounds.ts).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { guessDisc, guessThrowType, placeMadeThrowsAtBasket, remeasureHole, suggestDiscs } from '../../lib/rounds.ts';
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

describe('guessThrowType', () => {
  const basket = { latitude: 40.001, longitude: -75 };
  test('the first throw on a hole is a drive', () => {
    assert.equal(guessThrowType([], { latitude: 40, longitude: -75 }, basket), 'Drive');
  });
  test('a putt when thrown from within C2 of the basket, otherwise an approach', () => {
    const played = [shot(1, 'Fairway', 40.0008, -75)];
    assert.equal(guessThrowType(played, { latitude: 40.001 - 50 / 364_000, longitude: -75 }, basket), 'Putt', '50 ft away');
    assert.equal(guessThrowType(played, { latitude: 40.001 - 80 / 364_000, longitude: -75 }, basket), 'Approach', '80 ft away');
  });
  test('without a mapped basket, a putt follows a putt', () => {
    assert.equal(guessThrowType([shot(1, 'Missed')], null, null), 'Putt');
    assert.equal(guessThrowType([{ ...shot(1, 'Fairway'), type: 'Drive' }], null, null), 'Approach');
  });
});

describe('guessDisc', () => {
  const details = {
    Wraith: { id: '1', name: 'Wraith', brand: 'Innova', category: 'Distance Driver', speed: '11', glide: '5', turn: '-1', fade: '3', stability: 'Stable' },
    Aviar: { id: '2', name: 'Aviar', brand: 'Innova', category: 'Putter', speed: '2', glide: '3', turn: '0', fade: '1', stability: 'Stable' },
  };
  const bag = ['Wraith', 'Buzzz', 'Aviar'];
  test('the disc most recently used for that type of throw', () => {
    const recent = [{ ...shot(2, 'Fairway'), type: 'Approach' as const, disc: 'Buzzz' }, { ...shot(1, 'Fairway'), type: 'Drive' as const, disc: 'Wraith' }];
    assert.equal(guessDisc('Approach', recent, bag, details, 'Aviar'), 'Buzzz');
    assert.equal(guessDisc('Drive', recent, bag, details, 'Aviar'), 'Wraith');
  });
  test('falls back to the DiscIt category, ignoring discs no longer in the bag', () => {
    const recent = [{ ...shot(1, 'Basket'), type: 'Putt' as const, disc: 'Lost Putter' }];
    assert.equal(guessDisc('Putt', recent, bag, details, 'Wraith'), 'Aviar');
  });
  test('then the current disc, then the first in the bag', () => {
    assert.equal(guessDisc('Approach', [], bag, {}, 'Buzzz'), 'Buzzz');
    assert.equal(guessDisc('Approach', [], bag, {}, 'Gone'), 'Wraith');
    assert.equal(guessDisc('Drive', [], [], {}, ''), '');
  });
});

describe('suggestDiscs (the caddie)', () => {
  const thrown = (disc: string, type: 'Drive' | 'Approach' | 'Putt', feet: number, style: Shot['style'] = 'Backhand'): Shot =>
    ({ x: 0.5, y: 0.5, hole: 1, disc, type, feet, style });
  const history = [
    thrown('Wraith', 'Drive', 360), thrown('Wraith', 'Drive', 340), // avg 350
    thrown('Buzzz', 'Drive', 280), thrown('Buzzz', 'Drive', 290), thrown('Buzzz', 'Drive', 270), // avg 280
    thrown('Buzzz', 'Drive', 250, 'Forehand'), // forehand counted separately
    thrown('Leopard', 'Drive', 300),
    thrown('Old Disc', 'Drive', 285), // not in the bag any more
    thrown('Buzzz', 'Drive', 0), // no measured distance
    thrown('Aviar', 'Putt', 20), thrown('Aviar', 'Putt', 15), thrown('Envy', 'Putt', 25),
    thrown('Buzzz', 'Approach', 150),
  ];
  const bag = ['Wraith', 'Buzzz', 'Leopard', 'Aviar', 'Envy'];

  test('picks the discs whose average is closest to the distance, by disc and style', () => {
    const suggestions = suggestDiscs(285, 'Drive', history, bag);
    assert.deepEqual(suggestions.map((item) => [item.disc, item.style, item.averageFeet, item.count]), [
      ['Buzzz', 'Backhand', 280, 3],
      ['Leopard', 'Backhand', 300, 1],
      ['Buzzz', 'Forehand', 250, 1],
    ]);
  });

  test('approaches use approach history, falling back to any non-putt', () => {
    assert.deepEqual(suggestDiscs(160, 'Approach', history, bag).map((item) => item.disc), ['Buzzz']);
    assert.equal(suggestDiscs(160, 'Approach', history, ['Wraith'])[0].disc, 'Wraith', 'no approaches with Wraith yet: falls back to drives');
  });

  test('putts suggest the most-used putter, regardless of distance', () => {
    assert.deepEqual(suggestDiscs(30, 'Putt', history, bag).map((item) => [item.disc, item.count]), [['Aviar', 2], ['Envy', 1]]);
  });

  test('nothing to suggest without history', () => {
    assert.deepEqual(suggestDiscs(300, 'Drive', [], bag), []);
  });
});
