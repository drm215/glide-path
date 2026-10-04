import { Circle } from 'react-native-maps';
import type { GpsPoint } from '../../lib/types';

// C1 (10 m) and C2 (20 m) putting circles drawn around a basket.
export const BasketCircles = ({ basket }: { basket: Pick<GpsPoint, 'latitude' | 'longitude'> }) => (
  <>
    <Circle center={basket} radius={20} strokeColor="rgba(255,255,255,0.7)" strokeWidth={1.5} fillColor="rgba(255,255,255,0.06)" />
    <Circle center={basket} radius={10} strokeColor="rgba(255,255,255,0.9)" strokeWidth={1.5} fillColor="rgba(255,255,255,0.1)" />
  </>
);
