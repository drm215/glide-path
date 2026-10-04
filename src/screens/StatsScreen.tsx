import { useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { roundScore as statsRoundScore } from '../../lib/round-stats';
import { withExistingLayout } from '../../lib/layouts';
import type { SessionArchive } from '../../lib/types';
import { GREEN, styles } from '../theme';
import { formatScoreToPar, formatSessionDate } from '../format';
import { StatsSummary, StatTile } from '../components/StatsSummary';
import { ScreenHeading } from '../components/ScreenHeading';
import { openRound } from '../navigation';
import { useApp } from '../state/AppState';

export const StatsScreen = () => {
  const { courses, history } = useApp();
  // Filters: a course key ('all', a course id, or name:<course name>) and practice.
  const [statsCourse, setStatsCourse] = useState('all');
  const [statsPractice, setStatsPractice] = useState(false);

  // Stats screen: finished sessions, optionally with practice, grouped by course.
  const sessionLayouts = (session: SessionArchive) => {
    const base = courses.find((course) => course.id === session.courseId);
    return (base ? withExistingLayout(base, session.layoutId)?.layouts : undefined) ?? [];
  };
  const statsSessions = history.filter((session) => statsPractice || session.mode === 'Round');
  const statsCourseKey = (session: SessionArchive) => session.courseId ?? `name:${session.courseName}`;
  const statsCourses = [...statsSessions.reduce((groups, session) => {
    const key = statsCourseKey(session);
    const group = groups.get(key) ?? { key, name: courses.find((course) => course.id === session.courseId)?.name ?? session.courseName, sessions: [] as SessionArchive[] };
    group.sessions.push(session);
    return groups.set(key, group);
  }, new Map<string, { key: string; name: string; sessions: SessionArchive[] }>()).values()].sort((a, b) => b.sessions.length - a.sessions.length || a.name.localeCompare(b.name));
  const activeStatsCourse = statsCourses.some((group) => group.key === statsCourse) ? statsCourse : 'all';
  const statsSelected = activeStatsCourse === 'all' ? statsSessions : statsCourses.find((group) => group.key === activeStatsCourse)!.sessions;
  const statsScores = statsSelected.filter((session) => session.mode === 'Round').map((session) => ({ session, score: statsRoundScore(session.shots, sessionLayouts(session)) }));
  const statsWithPar = statsScores.filter((item) => item.score.toPar !== null);
  const statsBest = statsWithPar.reduce<(typeof statsWithPar)[number] | null>((best, item) => (!best || item.score.toPar! < best.score.toPar! ? item : best), null);
  const averageOf = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

  return <>
    <ScreenHeading eyebrow="ALL FINISHED ROUNDS" title="Stats." />
    <ScrollView contentContainerStyle={styles.content}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {[{ key: 'all', name: 'All courses', count: statsSessions.length }, ...statsCourses.map((group) => ({ key: group.key, name: group.name, count: group.sessions.length }))].map((option) => (
          <Pressable key={option.key} onPress={() => setStatsCourse(option.key)} style={[styles.chip, activeStatsCourse === option.key && styles.chipSelected]} accessibilityRole="button" accessibilityState={{ selected: activeStatsCourse === option.key }}>
            <Text style={[styles.chipText, activeStatsCourse === option.key && styles.chipTextSelected]}>{option.name} ({option.count})</Text>
          </Pressable>))}
      </ScrollView>
      <View style={[styles.toggleRow, styles.statsToggle]}>
        <Text style={[styles.courseItemName, styles.toggleCopy]}>Include practice sessions</Text>
        <Switch value={statsPractice} onValueChange={setStatsPractice} trackColor={{ true: GREEN }} accessibilityLabel="Include practice sessions" />
      </View>
      {!statsSelected.length ? <Text style={styles.mapInstruction}>No finished {statsPractice ? 'sessions' : 'rounds'} yet. Stats include rounds once you end them.</Text> : <>
        {statsScores.length > 0 && <View style={styles.courseStatsGrid}>
          <StatTile label="ROUNDS" value={statsScores.length} note={statsSelected.length > statsScores.length ? `+ ${statsSelected.length - statsScores.length} practice` : null} />
          <StatTile label="AVG SCORE" value={averageOf(statsScores.map((item) => item.score.strokes)).toFixed(1)} note={activeStatsCourse === 'all' && statsCourses.length > 1 ? 'Across different courses' : null} />
          <StatTile label="AVG TO PAR" value={statsWithPar.length ? formatScoreToPar(Math.round(averageOf(statsWithPar.map((item) => item.score.toPar!)) * 10) / 10) : '—'} note={statsWithPar.length < statsScores.length ? `${statsWithPar.length} of ${statsScores.length} rounds have pars` : null} />
          <Pressable onPress={() => { if (statsBest) openRound(statsBest.session.id); }} style={styles.courseStat} accessibilityRole="button" accessibilityLabel="Open best round">
            <Text style={styles.statLabel}>BEST ROUND</Text>
            <Text style={styles.courseStatValue}>{statsBest ? formatScoreToPar(statsBest.score.toPar!) : '—'}</Text>
            {statsBest && <Text style={styles.courseStatNote}>{statsBest.session.courseName} · {formatSessionDate(statsBest.session)} ›</Text>}
          </Pressable>
        </View>}
        {activeStatsCourse === 'all' && statsCourses.length > 1 && <>
          <Text style={styles.statsHeading}>By course</Text>
          {statsCourses.map((group) => {
            const scores = group.sessions.filter((session) => session.mode === 'Round').map((session) => statsRoundScore(session.shots, sessionLayouts(session)));
            const withPar = scores.filter((score) => score.toPar !== null);
            return <Pressable key={group.key} onPress={() => setStatsCourse(group.key)} style={styles.courseItem} accessibilityRole="button">
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
        <StatsSummary title="Throw stats" rounds={statsSelected.map((session) => ({ shots: session.shots, layouts: sessionLayouts(session) }))} scope="these rounds" />
      </>}
    </ScrollView>
  </>;
};
