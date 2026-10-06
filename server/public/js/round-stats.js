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
