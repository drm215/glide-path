// Copy of server/public/js/round-stats.js, shared by the app and website. Edit both together;
// server/test/stats-copy.test.ts fails if they differ (apart from this header).
// Round summary figures, kept free of browser APIs so the server tests can check them.

const TYPE_ORDER = ['Drive', 'Approach', 'Putt'];
const LANDING_ORDER = ['Fairway', 'Woods', 'Hazard', 'OB', 'Basket', 'Hit basket', 'Missed', 'Other'];
export const QUALITY_LABELS = { 1: 'Poor', 2: 'Fair', 3: 'Good' };

// Throws rated on the app's old 1–5 scale are converted to today's 1–3 scale.
export const quality = (shot) => (shot.quality ? Math.min(3, Math.max(1, Math.round((shot.quality / (shot.qualityMax ?? 5)) * 3))) : null);

// GPS accuracy (meters) past which a logged position is too unreliable to measure from. The app
// warns about readings this poor when a throw is logged.
export const POOR_ACCURACY_M = 15;

// A position counts as reliable unless its GPS accuracy is known to be poor; throws logged
// before accuracy was saved have none to judge by.
const reliablePosition = (point) => !(point?.accuracy > POOR_ACCURACY_M);

// The throws whose distance can be trusted. A distance runs from the previous positioned throw on
// the hole (or the tee) to this one, so both ends need a reliable position. Throws with no
// distance (0, no GPS reference) are never included.
export const reliableDistances = (rounds) => {
  const reliable = new Set();
  for (const round of rounds) {
    // Whether the last positioned throw on each hole was reliable; the tee counts as reliable.
    const lastLieReliable = new Map();
    for (const shot of round.shots) {
      const here = reliablePosition(shot);
      if (shot.feet > 0 && here && (lastLieReliable.get(shot.hole) ?? true)) reliable.add(shot);
      if (hasPosition(shot)) lastLieReliable.set(shot.hole, here);
    }
  }
  return reliable;
};

const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

const groupStats = (label, shots, reliable) => {
  const distances = shots.filter((shot) => reliable.has(shot)).map((shot) => shot.feet);
  return {
    label,
    count: shots.length,
    averageFeet: average(distances),
    longestFeet: distances.length ? Math.max(...distances) : null,
    averageQuality: average(shots.map(quality).filter((value) => value !== null)),
  };
};

const groupBy = (shots, key) => {
  const groups = new Map();
  for (const shot of shots) groups.set(key(shot), [...(groups.get(key(shot)) ?? []), shot]);
  return [...groups.entries()];
};

// Drive, Approach, Putt first, in playing order; anything else after.
const typeRank = (type) => (TYPE_ORDER.includes(type) ? TYPE_ORDER.indexOf(type) : TYPE_ORDER.length);

const EARTH_RADIUS_FEET = 20_902_231;
const feetBetween = (a, b) => {
  const rad = (degrees) => (degrees * Math.PI) / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * EARTH_RADIUS_FEET * Math.asin(Math.sqrt(h));
};

const hasPosition = (shot) => shot.latitude !== undefined && shot.longitude !== undefined;

// The first putt on each hole, and how far it was from the basket: measured from where it was
// thrown (the last positioned throw before it, or the tee) to the mapped basket. A throw's own
// distance is how far the disc travelled, which only equals the putt's length when it went in.
// A putt thrown from a position with poor GPS accuracy isn't measured.
const firstPutts = (shots, layouts, reliable) => [...new Set(shots.map((shot) => shot.hole))].flatMap((hole) => {
  const holeShots = shots.filter((shot) => shot.hole === hole);
  const index = holeShots.findIndex((shot) => shot.type === 'Putt');
  if (index < 0) return [];
  const putt = holeShots[index];
  const layout = layouts[hole - 1];
  const from = holeShots.slice(0, index).reverse().find(hasPosition) ?? layout?.tee;
  const made = putt.lie === 'Basket';
  const measurable = from && layout?.basket && reliablePosition(from);
  const feet = measurable ? Math.round(feetBetween(from, layout.basket)) : made && reliable.has(putt) ? putt.feet : null;
  return [{ made, feet }];
});

// Circles around the basket: C1 is within 10 m, C2 is from 10 m to 20 m.
export const C1_FEET = 10 / 0.3048;
export const C2_FEET = 20 / 0.3048;

// Where each drive stopped relative to the basket. Only drives with a logged position on a hole
// with a mapped basket can be measured, and only when the position's GPS accuracy is good; an OB
// drive is measured but isn't in play, so no circle.
const driveCircles = (shots, layouts) => {
  let measuredCount = 0;
  let c1 = 0;
  let c2 = 0;
  for (const shot of shots) {
    const basket = layouts[shot.hole - 1]?.basket;
    if (shot.type !== 'Drive' || !basket || (!hasPosition(shot) && shot.lie !== 'Basket')) continue;
    if (shot.lie !== 'Basket' && !reliablePosition(shot)) continue;
    measuredCount += 1;
    if (shot.lie === 'OB') continue;
    const feet = shot.lie === 'Basket' ? 0 : feetBetween(shot, basket);
    if (feet <= C1_FEET) c1 += 1;
    else if (feet <= C2_FEET) c2 += 1;
  }
  return { drives: shots.filter((shot) => shot.type === 'Drive').length, measured: measuredCount, c1, c2 };
};

// Stats across any number of rounds. Each round brings the hole layouts it was played on
// (optional), since first putts and drive circles are measured against that round's baskets.
// `reliable` is the set from reliableDistances; pass the full rounds' set when summarizing a
// filtered list of throws, since a filtered list no longer shows each throw's previous lie.
export const summarizeRounds = (rounds, reliable = reliableDistances(rounds)) => {
  const shots = rounds.flatMap((round) => round.shots);
  const distances = shots.filter((shot) => reliable.has(shot));
  const longest = distances.reduce((best, shot) => (!best || shot.feet > best.feet ? shot : best), null);
  const putts = shots.filter((shot) => shot.type === 'Putt');
  // A made putt is recorded at the basket, so its distance is how far it was from the basket.
  const madeDistances = putts.filter((shot) => shot.lie === 'Basket' && reliable.has(shot)).map((shot) => shot.feet);
  const firsts = rounds.flatMap((round) => firstPutts(round.shots, round.layouts ?? [], reliable));
  const firstDistances = firsts.map((item) => item.feet).filter((feet) => feet !== null);
  const circles = rounds.map((round) => driveCircles(round.shots, round.layouts ?? []))
    .reduce((total, item) => ({ drives: total.drives + item.drives, measured: total.measured + item.measured, c1: total.c1 + item.c1, c2: total.c2 + item.c2 }), { drives: 0, measured: 0, c1: 0, c2: 0 });
  return {
    count: shots.length,
    penalties: shots.filter((shot) => shot.lie === 'OB').length,
    totalFeet: distances.reduce((sum, shot) => sum + shot.feet, 0),
    longest: longest && { feet: longest.feet, disc: longest.disc, type: longest.type },
    averageQuality: average(shots.map(quality).filter((value) => value !== null)),
    byType: groupBy(shots, (shot) => shot.type || 'Other').sort(([a], [b]) => typeRank(a) - typeRank(b)).map(([label, group]) => groupStats(label, group, reliable)),
    // Only throws logged with a style; most-used first.
    byStyle: groupBy(shots.filter((shot) => shot.style), (shot) => shot.style).sort(([, a], [, b]) => b.length - a.length).map(([label, group]) => groupStats(label, group, reliable)),
    // Most-thrown disc first.
    byDisc: groupBy(shots, (shot) => shot.disc || 'No disc').sort(([, a], [, b]) => b.length - a.length).map(([label, group]) => groupStats(label, group, reliable)),
    putting: putts.length ? {
      attempts: putts.length,
      made: putts.filter((shot) => shot.lie === 'Basket').length,
      hit: putts.filter((shot) => shot.lie === 'Hit basket').length,
      missed: putts.filter((shot) => shot.lie === 'Missed').length,
      madePutts: {
        averageFeet: average(madeDistances),
        longestFeet: madeDistances.length ? Math.max(...madeDistances) : null,
        measured: madeDistances.length,
      },
      firstPutts: {
        attempts: firsts.length,
        made: firsts.filter((item) => item.made).length,
        averageFeet: average(firstDistances),
        measured: firstDistances.length,
      },
    } : null,
    driveCircles: circles,
    landings: LANDING_ORDER.map((lie) => ({ lie, count: shots.filter((shot) => shot.lie === lie).length })).filter((item) => item.count),
    qualities: [3, 2, 1].map((value) => ({ label: QUALITY_LABELS[value], count: shots.filter((shot) => quality(shot) === value).length })).filter((item) => item.count),
  };
};

// One round's stats; `layouts` are the hole layouts it was played on (optional).
export const summarizeRound = (shots, layouts = []) => summarizeRounds([{ shots, layouts }]);

// Matches the app: an out-of-bounds throw adds a penalty stroke.
const strokes = (shots) => shots.length + shots.filter((shot) => shot.lie === 'OB').length;

// A round's score and, over the holes that have a par, its score to par (null when none do).
export const roundScore = (shots, layouts = []) => {
  const holes = [...new Set(shots.map((shot) => shot.hole))];
  const withPar = holes.filter((hole) => layouts[hole - 1]?.par !== undefined);
  return {
    holes: holes.length,
    strokes: strokes(shots),
    toPar: withPar.length ? withPar.reduce((sum, hole) => sum + strokes(shots.filter((shot) => shot.hole === hole)) - layouts[hole - 1].par, 0) : null,
  };
};

// Putts from this close are tap-ins, left out of C1X putting (C1 putts from beyond 10 ft).
export const TAP_IN_FEET = 10;

// How far from the basket a throw stopped: 0 when it went in, null when that can't be measured
// (no mapped basket, no logged position, poor GPS accuracy, or out of bounds).
const lieFeet = (shot, basket) => {
  if (shot.lie === 'Basket') return 0;
  if (shot.lie === 'OB' || !basket || !hasPosition(shot) || !reliablePosition(shot)) return null;
  return feetBetween(shot, basket);
};

const circleOf = (feet) => (feet === null ? null : feet <= C1_FEET ? 'c1' : feet <= C2_FEET ? 'c2' : 'outside');

const ROUGH_LIES = ['Woods', 'Hazard', 'Other'];

// What happened on each hole of a round, for the scorecard: the drive's result, scrambling,
// greens in regulation, putts from inside the circles and the throw that went in.
// - driving: 'ace', 'c1' or 'c2' (a fairway drive measured inside a circle), 'fairway', 'rough'
//   (woods, hazard or other) or 'ob'; null when the drive has no landing spot.
// - scramble: after a drive into the rough or OB, whether the hole was still par or better.
// - green: the best circle reached within par − 2 strokes ('c1', 'c2' or 'missed'); null on
//   holes under par 3, with no par, or with no throw in regulation that could be measured.
// - c1x / c2: throws from 10–33 ft and 33–66 ft, measured from where each was thrown.
export const holeBreakdown = (shots, layouts = []) => {
  const reliable = reliableDistances([{ shots }]);
  return [...new Set(shots.map((shot) => shot.hole))].sort((a, b) => a - b).map((hole) => {
    const holeShots = shots.filter((shot) => shot.hole === hole);
    const layout = layouts[hole - 1];
    const basket = layout?.basket;
    const par = layout?.par ?? null;
    const score = strokes(holeShots);
    // How far from the basket each throw was thrown: the tee for the first, otherwise where the
    // previous throw stopped. A made throw with a trusted distance went exactly that far.
    const fromFeet = holeShots.map((shot, index) => {
      const tee = layout?.tee;
      const feet = index > 0 ? lieFeet(holeShots[index - 1], basket) : tee && basket && reliablePosition(tee) ? feetBetween(tee, basket) : null;
      return feet === null && shot.lie === 'Basket' && reliable.has(shot) ? shot.feet : feet;
    });

    const drive = holeShots[0];
    const driveCircle = circleOf(lieFeet(drive, basket));
    const driving = drive.lie === 'Basket' ? 'ace'
      : drive.lie === 'OB' ? 'ob'
        : ROUGH_LIES.includes(drive.lie) ? 'rough'
          : driveCircle === 'c1' || driveCircle === 'c2' ? driveCircle
            : drive.lie === 'Fairway' ? 'fairway' : null;

    let green = null;
    if (par !== null && par >= 3) {
      let taken = 0;
      let measured = false;
      for (const shot of holeShots) {
        taken += strokes([shot]);
        if (taken > par - 2) break;
        const circle = circleOf(lieFeet(shot, basket));
        if (circle !== null || shot.lie === 'OB') measured = true;
        if (circle === 'c1') { green = 'c1'; break; }
        if (circle === 'c2') green = 'c2';
      }
      if (!green && measured) green = 'missed';
    }

    const putts = (min, max) => {
      const attempts = holeShots.filter((shot, index) => fromFeet[index] !== null && fromFeet[index] > min && fromFeet[index] <= max);
      return { made: attempts.filter((shot) => shot.lie === 'Basket').length, attempts: attempts.length };
    };
    const last = holeShots.length - 1;
    return {
      hole,
      par,
      lengthFeet: layout?.tee && basket ? Math.round(feetBetween(layout.tee, basket)) : null,
      strokes: score,
      driving,
      scramble: par !== null && (driving === 'rough' || driving === 'ob') ? score <= par : null,
      green,
      c1x: putts(TAP_IN_FEET, C1_FEET),
      c2: putts(C1_FEET, C2_FEET),
      throwInFeet: holeShots[last].lie === 'Basket' && fromFeet[last] !== null ? Math.round(fromFeet[last]) : null,
      penalties: holeShots.filter((shot) => shot.lie === 'OB').length,
    };
  });
};

// Scoring percentages across any number of rounds, from each hole's breakdown. Made putts are
// the throws that went in from inside C2, tap-ins included.
export const scoringStats = (rounds) => {
  const holes = rounds.flatMap((round) => holeBreakdown(round.shots, round.layouts ?? []));
  const drives = holes.filter((hole) => hole.driving !== null);
  const scrambles = holes.filter((hole) => hole.scramble !== null);
  const greens = holes.filter((hole) => hole.green !== null);
  const putting = (key) => holes.reduce((total, hole) => ({ made: total.made + hole[key].made, attempts: total.attempts + hole[key].attempts }), { made: 0, attempts: 0 });
  const madePutts = holes.map((hole) => hole.throwInFeet).filter((feet) => feet !== null && feet <= C2_FEET);
  return {
    holes: holes.length,
    fairway: { hit: drives.filter((hole) => hole.driving !== 'rough' && hole.driving !== 'ob').length, drives: drives.length },
    scramble: { saved: scrambles.filter((hole) => hole.scramble).length, chances: scrambles.length },
    greens: { c1: greens.filter((hole) => hole.green === 'c1').length, c2: greens.filter((hole) => hole.green === 'c1' || hole.green === 'c2').length, holes: greens.length },
    c1x: putting('c1x'),
    c2: putting('c2'),
    madePutts: { count: madePutts.length, totalFeet: madePutts.reduce((sum, feet) => sum + feet, 0), averageFeet: average(madePutts), longestFeet: madePutts.length ? Math.max(...madePutts) : null },
    penalties: holes.reduce((sum, hole) => sum + hole.penalties, 0),
  };
};

// The value `fraction` (0–1) of the way up a sorted list, interpolating between neighbours (the
// spreadsheet PERCENTILE.INC method): 0.9 is the 90th percentile. Null for an empty list.
export const percentile = (sorted, fraction) => {
  if (!sorted.length) return null;
  const rank = (sorted.length - 1) * fraction;
  const below = Math.floor(rank);
  const above = Math.min(below + 1, sorted.length - 1);
  return sorted[below] + (sorted[above] - sorted[below]) * (rank - below);
};

// ---- flat-ground distances

// Feet of distance each foot of climb costs a throw: one thrown uphill would have gone this much
// further on flat ground for every foot it climbed, and one thrown downhill this much less for
// every foot it dropped.
export const FLAT_FEET_PER_FOOT = 2;

// Only full throws are adjusted. Putts aren't thrown for distance, and a throw that went in the
// basket stopped short of how far it would have gone, so both count as thrown.
const flatAdjusted = (shot) => (shot.type === 'Drive' || shot.type === 'Approach') && shot.lie !== 'Basket';

// The key a spot's ground elevation is looked up by.
export const groundKey = (point) => `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;

// Where each positioned throw in a round was thrown from: the previous positioned throw on its
// hole, else the hole's tee (from the round's layouts).
const throwOrigins = (round) => {
  const origins = new Map();
  const last = new Map();
  for (const shot of round.shots) {
    if (!hasPosition(shot)) continue;
    const from = last.get(shot.hole) ?? round.layouts?.[shot.hole - 1]?.tee ?? null;
    if (from) origins.set(shot, from);
    last.set(shot.hole, shot);
  }
  return origins;
};

// The spots whose ground elevation the flat-ground distances need, each once: where each full
// throw was thrown from and where it landed.
export const groundPoints = (rounds) => {
  const points = new Map();
  for (const round of rounds) {
    for (const [shot, from] of throwOrigins(round)) {
      if (!flatAdjusted(shot)) continue;
      for (const point of [from, shot]) points.set(groundKey(point), { latitude: point.latitude, longitude: point.longitude });
    }
  }
  return [...points.values()];
};

// Each reliably measured throw's flat-ground distance and how far it climbed (feet, negative for
// a drop), given `ground`: elevations in metres by groundKey. A full throw whose ends' elevations
// aren't known is left out; other throws count as thrown, with no climb.
const flatDistances = (rounds, reliable, ground) => {
  const flat = new Map();
  for (const round of rounds) {
    const origins = throwOrigins(round);
    for (const shot of round.shots) {
      if (!reliable.has(shot)) continue;
      if (!flatAdjusted(shot)) {
        flat.set(shot, { feet: shot.feet, riseFeet: null });
        continue;
      }
      const from = origins.get(shot);
      if (!from) continue;
      const start = ground?.get(groundKey(from));
      const end = ground?.get(groundKey(shot));
      if (typeof start !== 'number' || typeof end !== 'number') continue;
      const rise = (end - start) / 0.3048;
      flat.set(shot, { feet: Math.max(1, Math.round(shot.feet + FLAT_FEET_PER_FOOT * rise)), riseFeet: Math.round(rise) });
    }
  }
  return flat;
};

// Each disc's distances and throw quality, most-thrown first. Distances are the reliable ones
// (see reliableDistances), so `measured` can be fewer than `throws`. `types` limits it to those
// throw types (none means all). With `ground` (see flatDistances), flatAverageFeet is the average
// as if every throw were on flat ground, from the flatMeasured throws whose elevations are known.
export const discStats = (rounds, { types = [], ground } = {}) => {
  // Judged on the full rounds, since a throw's distance depends on the lie before it.
  const reliable = reliableDistances(rounds);
  const flat = flatDistances(rounds, reliable, ground);
  const shots = rounds.flatMap((round) => round.shots).filter((shot) => !types.length || types.includes(shot.type));
  return groupBy(shots, (shot) => shot.disc || 'No disc').sort(([, a], [, b]) => b.length - a.length).map(([disc, group]) => {
    const distances = group.filter((shot) => reliable.has(shot)).map((shot) => shot.feet).sort((a, b) => a - b);
    const ratings = group.map(quality);
    const flatFeet = group.flatMap((shot) => (flat.has(shot) ? [flat.get(shot).feet] : []));
    return {
      disc,
      throws: group.length,
      measured: distances.length,
      minFeet: distances.length ? distances[0] : null,
      maxFeet: distances.length ? distances[distances.length - 1] : null,
      averageFeet: average(distances),
      p90Feet: percentile(distances, 0.9),
      p95Feet: percentile(distances, 0.95),
      flatMeasured: flatFeet.length,
      flatAverageFeet: average(flatFeet),
      quality: {
        good: ratings.filter((value) => value === 3).length,
        fair: ratings.filter((value) => value === 2).length,
        poor: ratings.filter((value) => value === 1).length,
        unrated: ratings.filter((value) => value === null).length,
      },
      averageQuality: average(ratings.filter((value) => value !== null)),
    };
  });
};

// Every throw with one disc (named as in discStats, so 'No disc' for throws without one), each with the
// round it's from and its reliable distance (null when it can't be trusted): longest first, then
// the unmeasured ones in playing order. With `ground`, each also has its flat-ground distance and
// climb (see flatDistances; null when unknown). `rounds` may carry their own fields (an id, a
// date) for the caller; each entry's `round` is the object passed in. `types` limits it to those
// throw types (none means all).
export const discThrows = (rounds, disc, { types = [], ground } = {}) => {
  const reliable = reliableDistances(rounds);
  const flat = flatDistances(rounds, reliable, ground);
  const entries = rounds.flatMap((round) => round.shots
    .filter((shot) => (shot.disc || 'No disc') === disc && (!types.length || types.includes(shot.type)))
    .map((shot) => ({ round, shot, feet: reliable.has(shot) ? shot.feet : null, flatFeet: flat.get(shot)?.feet ?? null, riseFeet: flat.get(shot)?.riseFeet ?? null })));
  return [...entries.filter((entry) => entry.feet !== null).sort((a, b) => b.feet - a.feet), ...entries.filter((entry) => entry.feet === null)];
};

// The pars a round was played with, saved with it so later course edits don't rescore it: one
// entry per hole (index 0 is hole 1), null for a hole with no par. Each played hole takes its par
// from `layouts`; pars already saved (`saved`, say for a resumed round) are kept. Undefined when
// no played hole has a par.
export const parsToSave = (shots, layouts = [], saved = []) => {
  const played = new Set(shots.map((shot) => shot.hole));
  const count = Math.max(0, ...played, saved?.length ?? 0);
  const pars = Array.from({ length: count }, (_, index) => saved?.[index] ?? (played.has(index + 1) ? layouts[index]?.par ?? null : null));
  return pars.some((par) => par !== null) ? pars : undefined;
};

// A round's hole layouts with its saved pars (see parsToSave) in place of the course's current
// ones; holes without a saved par keep the course's. Tees and baskets still come from the course.
export const roundLayouts = (layouts = [], pars) => {
  if (!pars?.length) return layouts;
  return Array.from({ length: Math.max(layouts.length, pars.length) }, (_, index) => {
    const layout = layouts[index];
    const par = pars[index];
    return par === null || par === undefined ? layout : { tee: null, basket: null, ...layout, par };
  });
};

// Throw distances are measured from the previous logged lie (or the tee), so moving or removing a
// throw changes the distances after it. Throws without a position are left alone.
export const remeasureHole = (shots, hole, tee) => {
  let previous = tee ?? null;
  return shots.map((shot) => {
    if (shot.hole !== hole || !hasPosition(shot)) return shot;
    const point = { latitude: shot.latitude, longitude: shot.longitude };
    const feet = previous ? Math.max(1, Math.round(feetBetween(previous, point))) : 0;
    previous = point;
    return feet === shot.feet ? shot : { ...shot, feet };
  });
};

// A point placed by hand on the map, saved like a GPS point. With no reading behind it, it has no
// accuracy to doubt (so distances measured from it count) and no altitude.
export const placedPoint = (latitude, longitude, now) => ({ latitude, longitude, accuracy: null, altitude: null, timestamp: now });

// Moves throw `index` of a round's `shots` to where it was dragged on the map, then remeasures its
// hole from `tee`, since its distance and the next throw's depend on where it landed.
export const moveThrow = (shots, index, latitude, longitude, tee) => remeasureHole(
  shots.map((shot, position) => (position === index ? { ...shot, latitude, longitude, accuracy: null, altitude: null } : shot)),
  shots[index].hole,
  tee,
);
