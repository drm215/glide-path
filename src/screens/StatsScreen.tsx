import { useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { roundScore as statsRoundScore } from '../../lib/round-stats';
import { withExistingLayout } from '../../lib/layouts';
import type { SessionArchive } from '../../lib/types';
import { GREEN, styles } from '../theme';
import { formatScoreToPar, formatSessionDate } from '../format';
import { StatsSummary, StatTile } from '../components/StatsSummary';
import { HoleGrid, ScoreMark } from '../components/HoleGrid';
import { ScreenHeading } from '../components/ScreenHeading';
import { holeScoring, holesPlayed } from '../holeHistory';
import { openHoleHistory, openRound } from '../navigation';
import { useApp } from '../state/AppState';

export const StatsScreen = () => {
  const { courses, history } = useApp();
  // Filters: the chosen course keys (course ids, or name:<course name>; none means all courses)
  // and practice.
  const [statsPicked, setStatsPicked] = useState<string[]>([]);
  const [statsPractice, setStatsPractice] = useState(false);

  // Stats screen: finished sessions, optionally with practice, grouped by course.
  const sessionLayouts = (session: SessionArchive) => {
    const base = courses.find((course) => course.id === session.courseId);
    return (base ? withExistingLayout(base, session.layoutId)?.layouts : undefined) ?? [];
  };
  // A round still being played (on another device) isn't counted until it's finished.
  const statsSessions = history.filter((session) => !session.inProgress && (statsPractice || session.mode === 'Round'));
  const statsCourseKey = (session: SessionArchive) => session.courseId ?? `name:${session.courseName}`;
  const statsCourses = [...statsSessions.reduce((groups, session) => {
    const key = statsCourseKey(session);
    const group = groups.get(key) ?? { key, name: courses.find((course) => course.id === session.courseId)?.name ?? session.courseName, sessions: [] as SessionArchive[] };
    group.sessions.push(session);
    return groups.set(key, group);
  }, new Map<string, { key: string; name: string; sessions: SessionArchive[] }>()).values()].sort((a, b) => b.sessions.length - a.sessions.length || a.name.localeCompare(b.name));
  // Chosen courses with no sessions under the current filters are ignored.
  const activePicked = statsPicked.filter((key) => statsCourses.some((group) => group.key === key));
  const pickedGroups = activePicked.length ? statsCourses.filter((group) => activePicked.includes(group.key)) : statsCourses;
  const statsSelected = activePicked.length ? statsSessions.filter((session) => activePicked.includes(statsCourseKey(session))) : statsSessions;
  // Tapping a course adds it to the selection, or takes it out if it's already chosen.
  const toggleStatsCourse = (key: string) => setStatsPicked((picked) => (picked.includes(key) ? picked.filter((item) => item !== key) : [...picked, key]));
  const statsScores = statsSelected.filter((session) => session.mode === 'Round').map((session) => ({ session, score: statsRoundScore(session.shots, sessionLayouts(session)) }));
  const statsWithPar = statsScores.filter((item) => item.score.toPar !== null);
  const statsBest = statsWithPar.reduce<(typeof statsWithPar)[number] | null>((best, item) => (!best || item.score.toPar! < best.score.toPar! ? item : best), null);
  const averageOf = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  // With one course chosen, its holes, each opening every throw recorded on it.
  const holesCourse = activePicked.length === 1 ? courses.find((course) => course.id === activePicked[0]) : undefined;
  const holeGroups = holesCourse ? holesPlayed(history, holesCourse.id, statsPractice) : [];

  return <>
    <ScreenHeading eyebrow="ALL FINISHED ROUNDS" title="Stats." />
    <ScrollView contentContainerStyle={styles.content}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {[
          { key: 'all', name: 'All courses', count: statsSessions.length, selected: !activePicked.length, onPress: () => setStatsPicked([]) },
          ...statsCourses.map((group) => ({ key: group.key, name: group.name, count: group.sessions.length, selected: activePicked.includes(group.key), onPress: () => toggleStatsCourse(group.key) })),
        ].map((option) => (
          <Pressable key={option.key} onPress={option.onPress} style={[styles.chip, option.selected && styles.chipSelected]} accessibilityRole="button" accessibilityState={{ selected: option.selected }}>
            <Text style={[styles.chipText, option.selected && styles.chipTextSelected]}>{option.name} ({option.count})</Text>
          </Pressable>))}
      </ScrollView>
      {statsCourses.length > 1 && <Text style={styles.mapInstruction}>Pick one course or several to combine them.</Text>}
      <View style={[styles.toggleRow, styles.statsToggle]}>
        <Text style={[styles.courseItemName, styles.toggleCopy]}>Include practice sessions</Text>
        <Switch value={statsPractice} onValueChange={setStatsPractice} trackColor={{ true: GREEN }} accessibilityLabel="Include practice sessions" />
      </View>
      {!statsSelected.length ? <Text style={styles.mapInstruction}>No finished {statsPractice ? 'sessions' : 'rounds'} yet. Stats include rounds once you end them.</Text> : <>
        {statsScores.length > 0 && <View style={styles.courseStatsGrid}>
          <StatTile label="ROUNDS" value={statsScores.length} note={statsSelected.length > statsScores.length ? `+ ${statsSelected.length - statsScores.length} practice` : null} />
          <StatTile label="AVG SCORE" value={averageOf(statsScores.map((item) => item.score.strokes)).toFixed(1)} note={pickedGroups.length > 1 ? 'Across different courses' : null} />
          <StatTile label="AVG TO PAR" value={statsWithPar.length ? formatScoreToPar(Math.round(averageOf(statsWithPar.map((item) => item.score.toPar!)) * 10) / 10) : '—'} note={statsWithPar.length < statsScores.length ? `${statsWithPar.length} of ${statsScores.length} rounds have pars` : null} />
          <Pressable onPress={() => { if (statsBest) openRound(statsBest.session.id); }} style={styles.courseStat} accessibilityRole="button" accessibilityLabel="Open best round">
            <Text style={styles.statLabel}>BEST ROUND</Text>
            <Text style={styles.courseStatValue}>{statsBest ? formatScoreToPar(statsBest.score.toPar!) : '—'}</Text>
            {statsBest && <Text style={styles.courseStatNote}>{statsBest.session.courseName} · {formatSessionDate(statsBest.session)} ›</Text>}
          </Pressable>
        </View>}
        {pickedGroups.length > 1 && <>
          <Text style={styles.statsHeading}>By course</Text>
          {pickedGroups.map((group) => {
            const scores = group.sessions.filter((session) => session.mode === 'Round').map((session) => statsRoundScore(session.shots, sessionLayouts(session)));
            const withPar = scores.filter((score) => score.toPar !== null);
            return <Pressable key={group.key} onPress={() => setStatsPicked([group.key])} style={styles.courseItem} accessibilityRole="button">
              <View style={styles.courseItemCopy}>
                <Text style={styles.courseItemName}>{group.name}</Text>
                <Text style={styles.courseItemMeta}>{[
                  `${group.sessions.length} ${group.sessions.length === 1 ? 'session' : 'sessions'}`,
                  scores.length ? `avg ${averageOf(scores.map((score) => score.strokes)).toFixed(1)}` : null,
                  withPar.length ? `avg ${formatScoreToPar(Math.round(averageOf(withPar.map((score) => score.toPar!)) * 10) / 10)}` : null,
                  withPar.length ? `best ${formatScoreToPar(Math.min(...withPar.map((score) => score.toPar!)))}` : null,
                ].filter(Boolean).join(' · ')}</Text>
              </View>
              <Text style={styles.menuArrow}>›</Text>
            </Pressable>;
          })}
        </>}
        {holesCourse && holeGroups.length > 0 && <>
          <Text style={styles.statsHeading}>By hole</Text>
          <Text style={styles.mapInstruction}>Tap a hole to see every throw on it.</Text>
          {holeGroups.map((group) => {
            const layoutView = withExistingLayout(holesCourse, group.layoutId);
            return <View key={group.layoutId}>
              {holeGroups.length > 1 && <Text style={[styles.fieldLabel, styles.typeLabel]}>{(layoutView?.layoutLabel ?? 'Deleted').toUpperCase()} LAYOUT</Text>}
              <HoleGrid
                columns={group.holes.map(({ hole, visits }) => ({ hole, scoring: holeScoring(visits), played: visits.length, par: layoutView?.layouts?.[hole - 1]?.par ?? null }))}
                rows={[
                  { key: 'hole', label: 'Hole', style: 'head', cell: (column) => column.hole },
                  { key: 'par', label: 'Par', style: 'muted', cell: (column) => column.par },
                  { key: 'played', label: 'Played', style: 'muted', cell: (column) => column.played },
                  { key: 'average', label: 'Avg', tall: true, cell: ({ scoring, par }) => scoring.average === null ? null : <Text style={[styles.holeGridText, styles.holeGridHead, par !== null && scoring.average < par && styles.underPar, par !== null && scoring.average > par && styles.overPar]}>{scoring.average.toFixed(1)}</Text> },
                  { key: 'best', label: 'Best', tall: true, cell: ({ scoring, par }) => scoring.best === null ? null : <ScoreMark strokes={scoring.best} par={par} /> },
                ]}
                onPress={(column) => openHoleHistory(holesCourse.id, group.layoutId, column.hole, statsPractice)}
                pressLabel={(column) => `Every throw on hole ${column.hole}`}
              />
            </View>;
          })}
        </>}
        <StatsSummary title="Throw stats" rounds={statsSelected.map((session) => ({ shots: session.shots, layouts: sessionLayouts(session) }))} />
      </>}
    </ScrollView>
  </>;
};
