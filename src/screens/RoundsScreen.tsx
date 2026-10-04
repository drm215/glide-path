import { Pressable, ScrollView, Text, View } from 'react-native';
import { withExistingLayout } from '../../lib/layouts';
import type { SessionArchive } from '../../lib/types';
import { styles } from '../theme';
import { formatScoreToPar, formatSessionDate } from '../format';
import { scoreSummary } from '../scoring';
import { ScreenHeading } from '../components/ScreenHeading';
import { useApp } from '../state/AppState';

export const RoundsScreen = () => {
  const { courses, deleteRound, history, openRound } = useApp();
  const pastSessions = [...history].sort((a, b) => Number(b.id) - Number(a.id));

  const sessionSummary = (session: SessionArchive) => {
    const baseCourse = courses.find((course) => course.id === session.courseId);
    const summary = scoreSummary(session.shots, baseCourse ? withExistingLayout(baseCourse, session.layoutId) : undefined);
    const holesText = `${summary.holesCompleted} ${summary.holesCompleted === 1 ? 'hole' : 'holes'}`;
    if (session.mode === 'Practice') return `${holesText} · ${summary.strokes} ${summary.strokes === 1 ? 'throw' : 'throws'}`;
    return `${holesText} · Score ${summary.strokes}${summary.toPar === null ? '' : ` (${formatScoreToPar(summary.toPar)})`}`;
  };

  return <>
    <ScreenHeading eyebrow="PREVIOUS SESSIONS" title="Rounds." />
    <ScrollView contentContainerStyle={styles.content}>
      {!pastSessions.length && <View style={styles.menuIntro}><Text style={styles.menuIntroLabel}>NO ROUNDS YET</Text><Text style={styles.menuIntroCopy}>Finished rounds and practice sessions appear here. Use End round when you finish playing.</Text></View>}
      {pastSessions.map((session) => <View key={session.id} style={styles.courseItem}>
        <Pressable onPress={() => openRound(session.id)} style={styles.courseItemSelect} accessibilityRole="button">
          <View style={styles.courseItemCopy}><Text style={styles.courseItemName}>{session.courseName}</Text><Text style={styles.courseItemMeta}>{formatSessionDate(session)} · {sessionSummary(session)}</Text></View>
          {session.mode === 'Practice' && <Text style={styles.sessionModeTag}>PRACTICE</Text>}
          <Text style={styles.menuArrow}>›</Text>
        </Pressable>
        <Pressable onPress={() => deleteRound(session)} style={styles.deleteButton} accessibilityRole="button" accessibilityLabel={`Delete ${session.courseName} ${session.mode === 'Round' ? 'round' : 'practice session'} from ${formatSessionDate(session)}`}><Text style={styles.deleteButtonText}>DELETE</Text></Pressable>
      </View>)}
    </ScrollView>
  </>;
};
