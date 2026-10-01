// Round summary figures, kept free of browser APIs so the server tests can check them.

const TYPE_ORDER = ['Drive', 'Approach', 'Putt'];
const LANDING_ORDER = ['Fairway', 'Woods', 'Hazard', 'OB', 'Basket', 'Hit basket', 'Missed', 'Other'];
export const QUALITY_LABELS = { 1: 'Poor', 2: 'Fair', 3: 'Good' };

// Throws rated on the app's old 1–5 scale are converted to today's 1–3 scale.
export const quality = (shot) => (shot.quality ? Math.min(3, Math.max(1, Math.round((shot.quality / (shot.qualityMax ?? 5)) * 3))) : null);

// Distance is unknown (0) for throws with no GPS reference, so those are left out of distance figures.
const measured = (shots) => shots.filter((shot) => shot.feet > 0);

const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

const groupStats = (label, shots) => {
  const distances = measured(shots).map((shot) => shot.feet);
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
const firstPutts = (shots, layouts) => [...new Set(shots.map((shot) => shot.hole))].flatMap((hole) => {
  const holeShots = shots.filter((shot) => shot.hole === hole);
  const index = holeShots.findIndex((shot) => shot.type === 'Putt');
  if (index < 0) return [];
  const putt = holeShots[index];
  const layout = layouts[hole - 1];
  const from = holeShots.slice(0, index).reverse().find(hasPosition) ?? layout?.tee;
  const made = putt.lie === 'Basket';
  const feet = from && layout?.basket ? Math.round(feetBetween(from, layout.basket)) : made && putt.feet > 0 ? putt.feet : null;
  return [{ made, feet }];
});

// Circles around the basket: C1 is within 10 m, C2 is from 10 m to 20 m.
export const C1_FEET = 10 / 0.3048;
export const C2_FEET = 20 / 0.3048;

// Where each drive stopped relative to the basket. Only drives with a logged position on a hole
// with a mapped basket can be measured; an OB drive is measured but isn't in play, so no circle.
const driveCircles = (shots, layouts) => {
  let measuredCount = 0;
  let c1 = 0;
  let c2 = 0;
  for (const shot of shots) {
    const basket = layouts[shot.hole - 1]?.basket;
    if (shot.type !== 'Drive' || !basket || (!hasPosition(shot) && shot.lie !== 'Basket')) continue;
    measuredCount += 1;
    if (shot.lie === 'OB') continue;
    const feet = shot.lie === 'Basket' ? 0 : feetBetween(shot, basket);
    if (feet <= C1_FEET) c1 += 1;
    else if (feet <= C2_FEET) c2 += 1;
  }
  return { drives: shots.filter((shot) => shot.type === 'Drive').length, measured: measuredCount, c1, c2 };
};

// `layouts` are the hole layouts the round was played on, for first-putt distances and drive
// circles; optional.
export const summarizeRound = (shots, layouts = []) => {
  const distances = measured(shots);
  const longest = distances.reduce((best, shot) => (!best || shot.feet > best.feet ? shot : best), null);
  const putts = shots.filter((shot) => shot.type === 'Putt');
  const firsts = firstPutts(shots, layouts);
  const firstDistances = firsts.map((item) => item.feet).filter((feet) => feet !== null);
  return {
    count: shots.length,
    penalties: shots.filter((shot) => shot.lie === 'OB').length,
    totalFeet: distances.reduce((sum, shot) => sum + shot.feet, 0),
    longest: longest && { feet: longest.feet, disc: longest.disc, type: longest.type },
    averageQuality: average(shots.map(quality).filter((value) => value !== null)),
    byType: groupBy(shots, (shot) => shot.type || 'Other').sort(([a], [b]) => typeRank(a) - typeRank(b)).map(([label, group]) => groupStats(label, group)),
    // Only throws logged with a style; most-used first.
    byStyle: groupBy(shots.filter((shot) => shot.style), (shot) => shot.style).sort(([, a], [, b]) => b.length - a.length).map(([label, group]) => groupStats(label, group)),
    // Most-thrown disc first.
    byDisc: groupBy(shots, (shot) => shot.disc || 'No disc').sort(([, a], [, b]) => b.length - a.length).map(([label, group]) => groupStats(label, group)),
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
    driveCircles: driveCircles(shots, layouts),
    landings: LANDING_ORDER.map((lie) => ({ lie, count: shots.filter((shot) => shot.lie === lie).length })).filter((item) => item.count),
    qualities: [3, 2, 1].map((value) => ({ label: QUALITY_LABELS[value], count: shots.filter((shot) => quality(shot) === value).length })).filter((item) => item.count),
  };
};
