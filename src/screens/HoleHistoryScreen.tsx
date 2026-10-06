import MapView, { Marker, Polyline } from 'react-native-maps';
import { useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { courseLayouts, withExistingLayout } from '../../lib/layouts';
import type { ThrowType } from '../../lib/types';
import { RESULT_TYPES } from '../constants';
import { formatScoreToPar, formatSessionDate, formatThrowDetail } from '../format';
import { regionForPoints } from '../geo';
import { holeScoring, holeVisits } from '../holeHistory';
import { BasketCircles } from '../components/BasketCircles';
import { PREVIOUS_BACK, ScreenHeading } from '../components/ScreenHeading';
import { StatsSummary, StatTile } from '../components/StatsSummary';
import { openRound } from '../navigation';
import { useApp } from '../state/AppState';
import { styles } from '../theme';

// Throws on the map are colored by type, since there are too many to number.
export const THROW_TYPE_COLORS: Record<ThrowType, string> = { Drive: '#3a8f68', Approach: '#df8547', Putt: '#e6ece8' };

// Every recorded throw on one hole (/hole?course=&layout=&hole=, with practice=1 to include
// practice sessions): all of them on one map, the hole's scoring, its throw stats, and each visit.
export const HoleHistoryScreen = () => {
  const { courses, history } = useApp();
  const params = useLocalSearchParams<{ course: string; layout: string; hole: string; practice?: string }>();
  const holeNumber = Number(params.hole);
  const includePractice = params.practice === '1';
  const baseCourse = courses.find((course) => course.id === params.course);
  const course = baseCourse ? withExistingLayout(baseCourse, params.layout) : undefined;
  const layout = course?.layouts?.[holeNumber - 1];
  const par = layout?.par;
  const visits = holeVisits(history, params.course, params.layout, holeNumber, includePractice);
  const scoring = holeScoring(visits);
  const results = par === undefined ? [] : RESULT_TYPES.map((result) => ({ ...result, count: scoring.scores.filter((score) => result.matches(score - par)).length })).filter((result) => result.count > 0);
  const positioned = visits.map((visit) => ({
    visit,
    throws: visit.shots.flatMap((shot) => (shot.latitude !== undefined && shot.longitude !== undefined ? [{ shot, coordinate: { latitude: shot.latitude, longitude: shot.longitude } }] : [])),
  }));
  const region = regionForPoints([
    ...(layout?.tee ? [layout.tee] : []), ...(layout?.basket ? [layout.basket] : []),
    ...positioned.flatMap((item) => item.throws.map((entry) => entry.coordinate)),
  ]);
  const layoutLabel = baseCourse && course && courseLayouts(baseCourse).length > 1 ? ` · ${course.layoutLabel}` : '';

  return <>
    <ScreenHeading eyebrow={`${(baseCourse?.name ?? 'COURSE').toUpperCase()}${layoutLabel.toUpperCase()} · EVERY THROW`} title={`Hole ${String(holeNumber).padStart(2, '0')}.`} back={PREVIOUS_BACK} />
    <ScrollView contentContainerStyle={styles.content}>
      {!visits.length ? <Text style={styles.mapInstruction}>No throws recorded on this hole yet.</Text> : <>
        <View style={styles.courseStatsGrid}>
          <StatTile label="PLAYED" value={scoring.rounds} note={visits.length > scoring.rounds ? `+ ${visits.length - scoring.rounds} practice` : scoring.rounds === 1 ? 'round' : 'rounds'} />
          <StatTile label="PAR" value={par ?? '—'} note={par === undefined ? 'Not set' : null} />
          <StatTile label="AVG SCORE" value={scoring.average === null ? '—' : scoring.average.toFixed(1)} note={scoring.average === null || par === undefined ? null : formatScoreToPar(Math.round((scoring.average - par) * 10) / 10)} />
          <StatTile label="BEST" value={scoring.best ?? '—'} note={scoring.best === null || par === undefined ? null : formatScoreToPar(scoring.best - par)} />
        </View>
        {results.length > 0 && <View style={styles.resultChips}>{results.map((result) => <View key={result.label} style={styles.resultChip}><Text style={styles.resultChipText}>{result.count} {result.label}{result.count === 1 || result.label.endsWith('+') || result.label.endsWith('better') ? '' : 's'}</Text></View>)}</View>}

        <Text style={styles.statsHeading}>Every throw</Text>
        {region ? <View style={styles.roundHoleMap}>
          <MapView style={styles.satelliteMap} mapType="satellite" initialRegion={region} showsMyLocationButton={false}>
            {layout?.tee && layout.basket && <Polyline coordinates={[layout.tee, layout.basket]} strokeColor="#ffffff" strokeWidth={2} lineDashPattern={[6, 4]} />}
            {positioned.map(({ visit, throws }) => {
              const path = [...(layout?.tee ? [layout.tee] : []), ...throws.map((entry) => entry.coordinate)];
              return path.length > 1 ? <Polyline key={`path-${visit.session.id}`} coordinates={path} strokeColor="rgba(223,133,71,0.45)" strokeWidth={2} /> : null;
            })}
            {layout?.tee && <Marker coordinate={layout.tee} title={`Hole ${holeNumber} tee box`} pinColor="#1d684c" />}
            {layout?.basket && <BasketCircles basket={layout.basket} />}
            {layout?.basket && <Marker coordinate={layout.basket} title={`Hole ${holeNumber} basket`} pinColor="#d77d42" />}
            {positioned.flatMap(({ visit, throws }) => throws.map(({ shot, coordinate }, index) => (
              <Marker key={`${visit.session.id}-${index}`} coordinate={coordinate} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} title={formatSessionDate(visit.session)} description={formatThrowDetail(shot)}>
                <View style={[styles.throwDot, { backgroundColor: THROW_TYPE_COLORS[shot.type] }]} />
              </Marker>
            )))}
          </MapView>
        </View> : <Text style={styles.mapInstruction}>No map positions were saved for this hole.</Text>}
        <Text style={styles.mapLegend}>
          {(Object.keys(THROW_TYPE_COLORS) as ThrowType[]).map((type) => <Text key={type}><Text style={{ color: THROW_TYPE_COLORS[type] }}>●</Text> {type}   </Text>)}
        </Text>

        <StatsSummary title="Throws on this hole" rounds={visits.map((visit) => ({ shots: visit.shots, layouts: course?.layouts ?? [] }))} scope="these visits" />

        <Text style={styles.statsHeading}>Each time you played it</Text>
        {visits.map((visit) => <Pressable key={visit.session.id} onPress={() => openRound(visit.session.id)} style={styles.courseItem} accessibilityRole="button">
          <View style={styles.courseItemCopy}>
            <Text style={styles.courseItemName}>{formatSessionDate(visit.session)}</Text>
            <Text style={styles.courseItemMeta}>{[
              `${visit.strokes} ${visit.strokes === 1 ? 'stroke' : 'strokes'}${par === undefined ? '' : ` (${formatScoreToPar(visit.strokes - par)})`}`,
              visit.shots.map((shot) => shot.disc || 'No disc').join(' › '),
            ].join(' · ')}</Text>
          </View>
          {visit.session.mode === 'Practice' && <Text style={styles.sessionModeTag}>PRACTICE</Text>}
          <Text style={styles.menuArrow}>›</Text>
        </Pressable>)}
      </>}
    </ScrollView>
  </>;
};
