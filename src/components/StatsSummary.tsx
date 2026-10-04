import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { quality as qualityOf, QUALITY_LABELS as QUALITY_NAMES, summarizeRounds, type GroupStats, type StatsRound } from '../../lib/round-stats';
import type { ThrowType } from '../../lib/types';
import { FILTER_TYPES } from '../constants';
import { statFeet, statPercent, statQuality } from '../format';
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

// Throw stats for one or many rounds, matching the website's round summary. Each round brings
// the hole layouts it was played on, for first-putt distances and drive circles.
export const StatsSummary = ({ title, rounds, scope }: { title: string; rounds: StatsRound[]; scope: string }) => {
  const [discType, setDiscType] = useState<ThrowType | null>(null);
  const [discQuality, setDiscQuality] = useState<number | null>(null);
  const shots = rounds.flatMap((round) => round.shots);
  if (!shots.length) return null;
  const summary = summarizeRounds(rounds);
  const { putting, driveCircles } = summary;
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
      <View style={styles.courseStatsGrid}>
        <StatTile label="THROWS" value={summary.count} note={summary.penalties === 1 ? '1 OB penalty' : summary.penalties ? `${summary.penalties} OB penalties` : 'No penalties'} />
        <StatTile label="TOTAL DISTANCE" value={statFeet(summary.totalFeet)} note="Measured by GPS" />
        <StatTile label="LONGEST" value={statFeet(summary.longest?.feet ?? null)} note={summary.longest ? `${summary.longest.disc} ${summary.longest.type.toLowerCase()}` : null} />
        <StatTile label="AVG QUALITY" value={statQuality(summary.averageQuality)} note={summary.qualities.length ? null : 'Not rated'} />
      </View>
      <Text style={styles.statsHeading}>By throw type</Text>
      <GroupTable heading="TYPE" rows={summary.byType} />
      {summary.byStyle.length > 0 && <><Text style={styles.statsHeading}>By throw style</Text><GroupTable heading="STYLE" rows={summary.byStyle} /></>}
      {putting && <>
        <Text style={styles.statsHeading}>Putting</Text>
        <View style={styles.courseStatsGrid}>
          <StatTile label="FIRST-PUTT MAKES" value={statPercent(putting.firstPutts.made, putting.firstPutts.attempts)} note={`${putting.firstPutts.made} of ${putting.firstPutts.attempts} holes`} />
          <StatTile label="AVG FIRST PUTT" value={statFeet(putting.firstPutts.averageFeet)} note={putting.firstPutts.measured < putting.firstPutts.attempts ? `${putting.firstPutts.measured} of ${putting.firstPutts.attempts} measured` : 'From lie to basket'} />
          <StatTile label="ALL PUTTS" value={statPercent(putting.made, putting.attempts)} note={`${putting.made} of ${putting.attempts} made`} />
          <StatTile label="MISSES" value={putting.hit + putting.missed} note={`${putting.hit} hit the basket · ${putting.missed} missed`} />
        </View>
      </>}
      {driveCircles.drives > 0 && <>
        <Text style={styles.statsHeading}>Drives in the circles</Text>
        {driveCircles.measured ? <View style={styles.courseStatsGrid}>
          <StatTile label="IN C1" value={statPercent(driveCircles.c1, driveCircles.measured)} note={`${driveCircles.c1} of ${driveCircles.measured} · within 33 ft`} />
          <StatTile label="IN C2" value={statPercent(driveCircles.c2, driveCircles.measured)} note={`${driveCircles.c2} of ${driveCircles.measured} · 33–66 ft`} />
          <StatTile label="INSIDE C2" value={statPercent(driveCircles.c1 + driveCircles.c2, driveCircles.measured)} note={`${driveCircles.c1 + driveCircles.c2} of ${driveCircles.measured} drives`} />
          <StatTile label="MEASURED" value={`${driveCircles.measured}/${driveCircles.drives}`} note="Need a logged spot and mapped basket" />
        </View> : <Text style={styles.mapInstruction}>Circle hits need a drive’s logged landing spot and the hole’s mapped basket, and no drive in {scope} has both.</Text>}
      </>}
      <Text style={styles.statsHeading}>By disc</Text>
      {types.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {[filterChip('All throws', discType === null, () => setDiscType(null)), ...types.map((type) => filterChip(type, discType === type, () => setDiscType(type)))]}
      </ScrollView>}
      {ratings.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {[filterChip('Any quality', discQuality === null, () => setDiscQuality(null)), ...ratings.map((value) => filterChip(QUALITY_NAMES[value], discQuality === value, () => setDiscQuality(value)))]}
      </ScrollView>}
      {discShots.length ? <GroupTable heading="DISC" rows={summarizeRounds([{ shots: discShots }]).byDisc} /> : <Text style={styles.mapInstruction}>No throws match these filters.</Text>}
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
