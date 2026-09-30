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

export const summarizeRound = (shots) => {
  const distances = measured(shots);
  const longest = distances.reduce((best, shot) => (!best || shot.feet > best.feet ? shot : best), null);
  const putts = shots.filter((shot) => shot.type === 'Putt');
  return {
    count: shots.length,
    penalties: shots.filter((shot) => shot.lie === 'OB').length,
    totalFeet: distances.reduce((sum, shot) => sum + shot.feet, 0),
    longest: longest && { feet: longest.feet, disc: longest.disc, type: longest.type },
    averageQuality: average(shots.map(quality).filter((value) => value !== null)),
    byType: groupBy(shots, (shot) => shot.type || 'Other').sort(([a], [b]) => typeRank(a) - typeRank(b)).map(([label, group]) => groupStats(label, group)),
    // Most-thrown disc first.
    byDisc: groupBy(shots, (shot) => shot.disc || 'No disc').sort(([, a], [, b]) => b.length - a.length).map(([label, group]) => groupStats(label, group)),
    putting: putts.length ? {
      attempts: putts.length,
      made: putts.filter((shot) => shot.lie === 'Basket').length,
      hit: putts.filter((shot) => shot.lie === 'Hit basket').length,
      missed: putts.filter((shot) => shot.lie === 'Missed').length,
    } : null,
    landings: LANDING_ORDER.map((lie) => ({ lie, count: shots.filter((shot) => shot.lie === lie).length })).filter((item) => item.count),
    qualities: [3, 2, 1].map((value) => ({ label: QUALITY_LABELS[value], count: shots.filter((shot) => quality(shot) === value).length })).filter((item) => item.count),
  };
};
