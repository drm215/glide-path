import { useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { discStats, roundLayouts, type DiscStats } from '../../lib/round-stats';
import { withExistingLayout } from '../../lib/layouts';
import type { Course, SessionArchive, ThrowType } from '../../lib/types';
import { FILTER_TYPES } from '../constants';
import { statFeet, statQuality } from '../format';
import { ScreenHeading } from '../components/ScreenHeading';
import { openDiscThrows } from '../navigation';
import { useGroundElevations } from '../useGroundElevations';
import { useApp } from '../state/AppState';
import { GREEN, styles } from '../theme';

// Quality bar colors, matching the throw markers on the maps.
export const QUALITY_SEGMENTS = [
  { key: 'good', label: 'Good', color: '#2e9d5b' },
  { key: 'fair', label: 'Fair', color: '#e3b505' },
  { key: 'poor', label: 'Poor', color: '#d64541' },
  { key: 'unrated', label: 'Not rated', color: '#3b433f' },
] as const;

// Finished sessions for disc stats (practice too when `practice`), each with the hole layouts it
// was played on and the session itself, for linking back to it.
export const discSessions = (history: SessionArchive[], courses: Course[], practice: boolean) =>
  // A round still being played (on another device) isn't counted until it's finished.
  history.filter((session) => !session.inProgress && (practice || session.mode === 'Round')).map((session) => {
    const base = courses.find((course) => course.id === session.courseId);
    return { session, shots: session.shots, layouts: roundLayouts((base ? withExistingLayout(base, session.layoutId)?.layouts : undefined) ?? [], session.pars) };
  });

// The throw-type buttons (several at once; none means all) and the practice switch.
export const DiscFilters = ({ types, setTypes, practice, setPractice }: {
  types: ThrowType[]; setTypes: (types: ThrowType[]) => void; practice: boolean; setPractice: (practice: boolean) => void;
}) => {
  const chip = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} style={[styles.chip, selected && styles.chipSelected]} accessibilityRole="button" accessibilityState={{ selected }}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
  return <>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
      {[chip('All throws', !types.length, () => setTypes([])), ...FILTER_TYPES.map((type) => chip(type, types.includes(type), () => setTypes(types.includes(type) ? types.filter((item) => item !== type) : [...types, type])))]}
    </ScrollView>
    <View style={[styles.toggleRow, styles.statsToggle]}>
      <Text style={[styles.courseItemName, styles.toggleCopy]}>Include practice sessions</Text>
      <Switch value={practice} onValueChange={setPractice} trackColor={{ true: GREEN }} accessibilityLabel="Include practice sessions" />
    </View>
  </>;
};

// One disc's distance figures and quality bar. With `onPress`, the card opens the disc's throws.
export const DiscCard = ({ stats, onPress }: { stats: DiscStats; onPress?: () => void }) => {
  const segments = QUALITY_SEGMENTS.filter((segment) => stats.quality[segment.key]);
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={styles.discCard} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={onPress ? `Every throw with the ${stats.disc}` : undefined}>
      <View style={styles.discCardHeader}>
        <Text style={styles.discCardName} numberOfLines={1}>{stats.disc}</Text>
        <Text style={styles.discCardMeta}>{stats.throws} {stats.throws === 1 ? 'throw' : 'throws'}{stats.measured < stats.throws ? ` · ${stats.measured} measured` : ''}{onPress ? '  ›' : ''}</Text>
      </View>
      <View style={styles.discFigures}>
        {([['MIN', stats.minFeet], ['AVG', stats.averageFeet], ['90TH', stats.p90Feet], ['95TH', stats.p95Feet], ['MAX', stats.maxFeet], ['FLAT AVG', stats.flatAverageFeet]] as const).map(([label, feet]) => (
          <View key={label} style={styles.discFigure}>
            <Text style={styles.statLabel}>{label}</Text>
            <Text style={styles.discFigureValue} numberOfLines={1} adjustsFontSizeToFit>{statFeet(feet)}</Text>
          </View>
        ))}
      </View>
      <View style={styles.discQualityBar} accessibilityLabel={`Quality: ${segments.map((segment) => `${stats.quality[segment.key]} ${segment.label.toLowerCase()}`).join(', ')}`}>
        {segments.map((segment) => <View key={segment.key} style={{ flex: stats.quality[segment.key], backgroundColor: segment.color }} />)}
      </View>
      <Text style={styles.discQualityText}>
        {[...segments.map((segment) => `${segment.label} ${stats.quality[segment.key]}`), stats.averageQuality === null ? null : `avg ${statQuality(stats.averageQuality)}`].filter(Boolean).join('  ·  ')}
      </Text>
    </Pressable>
  );
};

// Distance and quality by disc across finished rounds: min, average, 90th and 95th percentile,
// max, and how the throws were rated. A disc's card opens each of its throws.
export const DiscStatsScreen = () => {
  const { courses, history } = useApp();
  const [types, setTypes] = useState<ThrowType[]>([]);
  const [practice, setPractice] = useState(false);
  const sessions = discSessions(history, courses, practice);
  const ground = useGroundElevations(sessions);
  const discs = discStats(sessions, { types, ground });

  return <>
    <ScreenHeading eyebrow="ALL FINISHED ROUNDS" title="Discs." />
    <ScrollView contentContainerStyle={styles.content}>
      <DiscFilters types={types} setTypes={setTypes} practice={practice} setPractice={setPractice} />
      <Text style={styles.mapInstruction}>Distances use only throws with a reliable GPS measurement. The 90th percentile is the distance 9 in 10 measured throws stay within; the 95th, 19 in 20. Flat avg is the average as if every drive and approach were thrown on flat ground: 2 ft added for each foot a throw climbed, 2 ft taken off for each foot it dropped. Tap a disc to see each throw.</Text>
      {discs.length ? discs.map((stats) => <DiscCard key={stats.disc} stats={stats} onPress={() => openDiscThrows(stats.disc, types, practice)} />) : <Text style={styles.mapInstruction}>No throws match yet.</Text>}
    </ScrollView>
  </>;
};
