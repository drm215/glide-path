import MapView, { Marker, Polyline } from 'react-native-maps';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { HoleLayout } from '../../lib/types';
import { formatElevation } from '../format';
import { holeDistanceFeet, holeElevationFeet, regionForPoints } from '../geo';
import { styles } from '../theme';
import { BasketCircles } from './BasketCircles';
import { HoleGrid } from './HoleGrid';

// "Hole 03 · Par 3 · 245 ft · ↓ 12 ft", leaving out what isn't known. Elevation comes from the
// GPS heights saved with the tee and basket.
const holeSummary = (hole: number, layout: HoleLayout | null | undefined) => [
  `Hole ${String(hole).padStart(2, '0')}`,
  layout?.par ? `Par ${layout.par}` : null,
  layout && holeDistanceFeet(layout) !== null ? `${holeDistanceFeet(layout)} ft` : null,
  layout && holeElevationFeet(layout) !== null ? formatElevation(holeElevationFeet(layout)!) : null,
].filter(Boolean).join(' · ');

// One layout of a course on the satellite map (each hole's numbered tee, basket and the line
// between), then its holes' pars, lengths and elevation changes. Tapping a hole shows it on its
// own with a summary; `onOpen3d` (when given) offers that hole in 3D.
export const CourseMap = ({ layouts, onOpen3d }: { layouts: (HoleLayout | null | undefined)[]; onOpen3d?: (hole: number) => void }) => {
  const [picked, setPicked] = useState<number | null>(null);
  const shown = layouts.map((layout, index) => (picked === null || picked === index + 1 ? layout : null));
  const points = shown.flatMap((layout) => [layout?.tee, layout?.basket]).filter((point): point is NonNullable<typeof point> => Boolean(point));
  const region = regionForPoints(points);
  const holes = layouts.map((layout, index) => ({
    hole: index + 1,
    par: layout?.par ?? null,
    feet: layout ? holeDistanceFeet(layout) : null,
    rise: layout ? holeElevationFeet(layout) : null,
  }));
  return <>
    {picked !== null && <View style={styles.holeSummary}>
      <Text style={styles.holeSummaryText}>{holeSummary(picked, layouts[picked - 1])}</Text>
      <View style={styles.holeSummaryLinks}>
        <Pressable onPress={() => setPicked(null)} style={styles.textLink} accessibilityRole="button"><Text style={styles.textLinkText}>‹ ALL HOLES</Text></Pressable>
        {onOpen3d && <Pressable onPress={() => onOpen3d(picked)} style={styles.textLink} accessibilityRole="button" accessibilityLabel={`Hole ${picked} in 3D`}><Text style={styles.textLinkText}>3D VIEW ›</Text></Pressable>}
      </View>
    </View>}
    {region ? <View style={styles.roundHoleMap}>
      {/* Keyed by the hole shown, so the map moves to it. */}
      <MapView key={picked ?? 'all'} style={styles.satelliteMap} mapType="satellite" initialRegion={region} showsMyLocationButton={false}>
        {shown.map((layout, index) => layout?.tee && layout.basket
          ? <Polyline key={`line-${index}`} coordinates={[layout.tee, layout.basket]} strokeColor="#ffffff" strokeWidth={2} lineDashPattern={[6, 4]} />
          : null)}
        {shown.map((layout, index) => layout?.basket ? <BasketCircles key={`circles-${index}`} basket={layout.basket} /> : null)}
        {shown.map((layout, index) => layout?.basket
          ? <Marker key={`basket-${index}`} coordinate={layout.basket} title={`Hole ${index + 1} basket`} pinColor="#d77d42" />
          : null)}
        {shown.map((layout, index) => layout?.tee
          ? <Marker key={`tee-${index}`} coordinate={layout.tee} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} title={`Hole ${index + 1} tee`}>
            <View style={[styles.shotMarker, styles.teeMarker]}><Text style={styles.shotPinText}>{index + 1}</Text></View>
          </Marker>
          : null)}
      </MapView>
    </View> : <Text style={styles.mapInstruction}>{picked === null ? 'No holes on this layout have been mapped yet.' : 'This hole hasn’t been mapped yet.'}</Text>}
    {holes.length > 0 && <>
      <HoleGrid
        columns={holes}
        active={picked}
        onPress={(column) => setPicked(column.hole)}
        pressLabel={(column) => `Show hole ${column.hole}`}
        rows={[
          { key: 'hole', label: 'Hole', style: 'head', cell: (column) => column.hole },
          { key: 'par', label: 'Par', style: 'muted', cell: (column) => column.par, total: holes.every((column) => column.par !== null) ? holes.reduce((sum, column) => sum + column.par!, 0) : null },
          { key: 'feet', label: 'Length (ft)', style: 'muted', cell: (column) => column.feet, total: holes.every((column) => column.feet !== null) ? holes.reduce((sum, column) => sum + column.feet!, 0) : null },
          { key: 'rise', label: 'Elev. (ft)', style: 'muted', cell: (column) => (column.rise === null ? null : column.rise > 0 ? `+${column.rise}` : column.rise) },
        ]}
      />
      <Text style={styles.mapInstruction}>Tap a hole to see it on its own.</Text>
    </>}
  </>;
};
