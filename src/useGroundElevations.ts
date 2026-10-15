import { useEffect, useState } from 'react';
import { getElevations } from '../lib/api';
import { groundKey, groundPoints, type GroundElevations } from '../lib/round-stats';
import { useApp } from './state/AppState';

// Ground elevations (metres by groundKey, null where unknown) for flat-ground distances, looked
// up on the server and kept while the app runs.
const ground: GroundElevations = new Map();
const ELEVATIONS_PER_REQUEST = 2000;

// The elevations disc stats need for `rounds`, fetching any not yet known. Returns the shared map,
// re-rendering once more arrive; offline, flat-ground figures stay blank.
export const useGroundElevations = (rounds: Parameters<typeof groundPoints>[0]) => {
  const { account } = useApp();
  const token = account?.token;
  const [, setArrived] = useState(0);
  const missing = groundPoints(rounds).filter((point) => !ground.has(groundKey(point)));
  const missingKey = missing.map(groundKey).join('|');

  useEffect(() => {
    if (!token || !missing.length) return;
    let current = true;
    (async () => {
      for (let start = 0; start < missing.length; start += ELEVATIONS_PER_REQUEST) {
        const batch = missing.slice(start, start + ELEVATIONS_PER_REQUEST);
        const { elevations } = await getElevations(token, batch);
        batch.forEach((point, index) => ground.set(groundKey(point), elevations[index] ?? null));
      }
      if (current) setArrived((count) => count + 1);
    })().catch(() => {});
    return () => { current = false; };
    // Keyed by the points still missing, not the (new each render) array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, missingKey]);

  return ground;
};
