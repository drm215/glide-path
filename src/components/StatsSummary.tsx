import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { quality as qualityOf, QUALITY_LABELS as QUALITY_NAMES, reliableDistances, scoringStats, summarizeRounds, type GroupStats, type ScoringStats, type StatsRound } from '../../lib/round-stats';
import type { ThrowType } from '../../lib/types';
import { FILTER_TYPES } from '../constants';
import { statFeet, statQuality } from '../format';
import { styles } from '../theme';

export const StatTile = ({ label, value, note }: { label: string; value: string | number; note?: string | null }) => (
  <View style={styles.courseStat}>
    <Text style={styles.statLabel}>{label}</Text>
    <Text style={styles.courseStatValue}>{value}</Text>
    {note ? <Text style={styles.courseStatNote}>{note}</Text> : null}
  </View>
);

export const GroupTable = ({ heading, rows }: { heading: string; rows: GroupStats[] }) => (
  <View style={styles.statTable}>
    <View style={[styles.statTableRow, styles.statTableHead]}>
      {[heading, 'THROWS', 'AVG', 'LONGEST', 'QUALITY'].map((label, index) => <Text key={label} style={[index ? styles.statCell : styles.statCellName, styles.statHeadText]}>{label}</Text>)}
    </View>
    {rows.map((row) => <View key={row.label} style={styles.statTableRow}>
      <Text style={styles.statCellName} numberOfLines={1}>{row.label}</Text>
      <Text style={styles.statCell}>{row.count}</Text>
      <Text style={styles.statCell}>{statFeet(row.averageFeet)}</Text>
      <Text style={styles.statCell}>{statFeet(row.longestFeet)}</Text>
      <Text style={styles.statCell}>{statQuality(row.averageQuality)}</Text>
    </View>)}
  </View>
);

// One percentage bar: `count` of `of` filled in green, with an optional inner share (C1 inside C2).
const StatBar = ({ count, of, inner, children }: { count: number; of: number; inner?: number; children: ReactNode }) => {
  const share = (value: number) => Math.round((value / of) * 100);
  const fill = (value: number, outer: boolean) => <View style={[styles.statBarFill, outer && styles.statBarFillOuter, { width: `${share(value)}%` }]}>
    {share(value) >= 12 && <Text style={styles.statBarPercent}>{share(value)}%</Text>}
  </View>;
  return <View style={styles.statBarRow}>
    <View style={styles.statBarTrack}>
      {inner === undefined ? fill(count, false) : <>{fill(count, true)}{fill(inner, false)}</>}
    </View>
    <Text style={styles.statBarLabel}>{children}</Text>
  </View>;
};

const Count = ({ count, of }: { count: number; of: number }) => <Text style={styles.statBarCount}>{count}/{of}</Text>;

// Scoring percentages: fairways, scrambles, greens in regulation and putting from the circles,
// then made-putt distances and out-of-bounds throws.
export const ScoringBars = ({ stats }: { stats: ScoringStats }) => {
  const { fairway, scramble, greens, c1x, c2, madePutts, penalties } = stats;
  if (!stats.holes) return null;
  return <View style={styles.statBars}>
    {fairway.drives > 0 && <StatBar count={fairway.hit} of={fairway.drives}><Count count={fairway.hit} of={fairway.drives} /> Fairway</StatBar>}
    {scramble.chances > 0 && <StatBar count={scramble.saved} of={scramble.chances}><Count count={scramble.saved} of={scramble.chances} /> Scramble</StatBar>}
    {greens.holes > 0 && <StatBar count={greens.c2} inner={greens.c1} of={greens.holes}><Count count={greens.c1} of={greens.holes} /> C1R  <Count count={greens.c2} of={greens.holes} /> C2R</StatBar>}
    {c1x.attempts > 0 && <StatBar count={c1x.made} of={c1x.attempts}><Count count={c1x.made} of={c1x.attempts} /> C1X Putting</StatBar>}
    {c2.attempts > 0 && <StatBar count={c2.made} of={c2.attempts}><Count count={c2.made} of={c2.attempts} /> C2 Putting</StatBar>}
    {madePutts.count > 0 && <Text style={styles.statBarNote}>
      <Text style={styles.statBarCount}>{madePutts.averageFeet!.toFixed(1)} ft</Text> avg putt   <Text style={styles.statBarCount}>{madePutts.totalFeet.toLocaleString()} ft</Text> total putt   <Text style={styles.statBarCount}>{madePutts.longestFeet} ft</Text> long
    </Text>}
    <Text style={styles.statBarNote}>
      <Text style={styles.statBarCount}>{penalties}</Text> OB   <Text style={styles.statBarCount}>{(penalties / stats.holes).toFixed(3).replace(/^0/, '')}</Text> OB rate
    </Text>
  </View>;
};

// Scoring and throw stats for one or many rounds. Each round brings the hole layouts it was
// played on, since circles, greens and putt distances are measured against its baskets.
export const StatsSummary = ({ title, rounds }: { title: string; rounds: StatsRound[] }) => {
  const [discType, setDiscType] = useState<ThrowType | null>(null);
  const [discQuality, setDiscQuality] = useState<number | null>(null);
  const shots = rounds.flatMap((round) => round.shots);
  if (!shots.length) return null;
  const reliable = reliableDistances(rounds);
  const summary = summarizeRounds(rounds, reliable);
  const scoring = scoringStats(rounds);
  const types = FILTER_TYPES.filter((type) => shots.some((shot) => shot.type === type));
  const ratings = [3, 2, 1].filter((value) => shots.some((shot) => qualityOf(shot) === value));
  const discShots = shots.filter((shot) => (discType === null || shot.type === discType) && (discQuality === null || qualityOf(shot) === discQuality));
  const filterChip = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} style={[styles.chip, selected && styles.chipSelected]} accessibilityRole="button" accessibilityState={{ selected }}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.statsSection}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <ScoringBars stats={scoring} />
      <View style={styles.courseStatsGrid}>
        <StatTile label="THROWS" value={summary.count} note={summary.penalties === 1 ? '1 OB penalty' : summary.penalties ? `${summary.penalties} OB penalties` : 'No penalties'} />
        <StatTile label="TOTAL DISTANCE" value={statFeet(summary.totalFeet)} note="Measured by GPS" />
        <StatTile label="LONGEST" value={statFeet(summary.longest?.feet ?? null)} note={summary.longest ? `${summary.longest.disc} ${summary.longest.type.toLowerCase()}` : null} />
        <StatTile label="AVG QUALITY" value={statQuality(summary.averageQuality)} note={summary.qualities.length ? null : 'Not rated'} />
      </View>
      <Text style={styles.statsHeading}>By throw type</Text>
      <GroupTable heading="TYPE" rows={summary.byType} />
      {summary.byStyle.length > 0 && <><Text style={styles.statsHeading}>By throw style</Text><GroupTable heading="STYLE" rows={summary.byStyle} /></>}
      <Text style={styles.statsHeading}>By disc</Text>
      {types.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {[filterChip('All throws', discType === null, () => setDiscType(null)), ...types.map((type) => filterChip(type, discType === type, () => setDiscType(type)))]}
      </ScrollView>}
      {ratings.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {[filterChip('Any quality', discQuality === null, () => setDiscQuality(null)), ...ratings.map((value) => filterChip(QUALITY_NAMES[value], discQuality === value, () => setDiscQuality(value)))]}
      </ScrollView>}
      {discShots.length ? <GroupTable heading="DISC" rows={summarizeRounds([{ shots: discShots }], reliable).byDisc} /> : <Text style={styles.mapInstruction}>No throws match these filters.</Text>}
      {summary.landings.length > 0 && <>
        <Text style={styles.statsHeading}>Where throws landed</Text>
        <Text style={styles.statsChips}>{summary.landings.map((item) => `${item.lie === 'Basket' ? 'In the basket' : item.lie} ${item.count}`).join('  ·  ')}</Text>
      </>}
      {summary.qualities.length > 0 && <>
        <Text style={styles.statsHeading}>Throw quality</Text>
        <Text style={styles.statsChips}>{summary.qualities.map((item) => `${item.label} ${item.count}`).join('  ·  ')}</Text>
      </>}
    </View>
  );
};
