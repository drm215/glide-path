import { useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { discStats, type DiscStats } from '../../lib/round-stats';
import { withExistingLayout } from '../../lib/layouts';
import type { SessionArchive, ThrowType } from '../../lib/types';
import { FILTER_TYPES } from '../constants';
import { statFeet, statQuality } from '../format';
import { ScreenHeading } from '../components/ScreenHeading';
import { useApp } from '../state/AppState';
import { GREEN, styles } from '../theme';

// Quality bar colors, matching the throw markers on the maps.
export const QUALITY_SEGMENTS = [
  { key: 'good', label: 'Good', color: '#2e9d5b' },
  { key: 'fair', label: 'Fair', color: '#e3b505' },
  { key: 'poor', label: 'Poor', color: '#d64541' },
  { key: 'unrated', label: 'Not rated', color: '#3b433f' },
] as const;

const DiscCard = ({ stats }: { stats: DiscStats }) => {
  const segments = QUALITY_SEGMENTS.filter((segment) => stats.quality[segment.key]);
  return (
    <View style={styles.discCard}>
      <View style={styles.discCardHeader}>
        <Text style={styles.discCardName} numberOfLines={1}>{stats.disc}</Text>
        <Text style={styles.discCardMeta}>{stats.throws} {stats.throws === 1 ? 'throw' : 'throws'}{stats.measured < stats.throws ? ` · ${stats.measured} measured` : ''}</Text>
      </View>
      <View style={styles.discFigures}>
        {([['MIN', stats.minFeet], ['AVG', stats.averageFeet], ['90TH', stats.p90Feet], ['95TH', stats.p95Feet], ['MAX', stats.maxFeet]] as const).map(([label, feet]) => (
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
    </View>
  );
};

// Distance and quality by disc across finished rounds: min, average, 90th and 95th percentile,
// max, and how the throws were rated. Throw-type buttons pick several at once; none means all.
export const DiscStatsScreen = () => {
  const { courses, history } = useApp();
  const [types, setTypes] = useState<ThrowType[]>([]);
  const [practice, setPractice] = useState(false);
  const layoutsFor = (session: SessionArchive) => {
    const base = courses.find((course) => course.id === session.courseId);
    return (base ? withExistingLayout(base, session.layoutId)?.layouts : undefined) ?? [];
  };
  // A round still being played (on another device) isn't counted until it's finished.
  const sessions = history.filter((session) => !session.inProgress && (practice || session.mode === 'Round'));
  const discs = discStats(sessions.map((session) => ({ shots: session.shots, layouts: layoutsFor(session) })), { types });
  const toggleType = (type: ThrowType) => setTypes((picked) => (picked.includes(type) ? picked.filter((item) => item !== type) : [...picked, type]));
  const chip = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} style={[styles.chip, selected && styles.chipSelected]} accessibilityRole="button" accessibilityState={{ selected }}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );

  return <>
    <ScreenHeading eyebrow="ALL FINISHED ROUNDS" title="Discs." />
    <ScrollView contentContainerStyle={styles.content}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {[chip('All throws', !types.length, () => setTypes([])), ...FILTER_TYPES.map((type) => chip(type, types.includes(type), () => toggleType(type)))]}
      </ScrollView>
      <View style={[styles.toggleRow, styles.statsToggle]}>
        <Text style={[styles.courseItemName, styles.toggleCopy]}>Include practice sessions</Text>
        <Switch value={practice} onValueChange={setPractice} trackColor={{ true: GREEN }} accessibilityLabel="Include practice sessions" />
      </View>
      <Text style={styles.mapInstruction}>Distances use only throws with a reliable GPS measurement. The 90th percentile is the distance 9 in 10 measured throws stay within; the 95th, 19 in 20.</Text>
      {discs.length ? discs.map((stats) => <DiscCard key={stats.disc} stats={stats} />) : <Text style={styles.mapInstruction}>No throws match yet.</Text>}
    </ScrollView>
  </>;
};
