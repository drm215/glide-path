import { Pressable, ScrollView, Text, View } from 'react-native';
import { styles } from '../theme';
import { ScreenHeading } from '../components/ScreenHeading';
import { useApp } from '../state/AppState';

export const PracticeScreen = () => {
  const { confirmNewSession, practiceFocus, selectedCourse, setPracticeFocus } = useApp();
  const startPractice = () => confirmNewSession('Practice');

  return <>
    <ScreenHeading eyebrow="FOCUSED SESSION" title="Practice." />
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.practiceIntro}><Text style={styles.menuIntroLabel}>SET A SESSION FOCUS</Text><Text style={styles.practiceIntroTitle}>What are you working on?</Text><Text style={styles.practiceIntroCopy}>Log throws at {selectedCourse?.name ?? 'your practice area'} and compare the results after your session.</Text></View>
      {['Distance', 'Accuracy', 'Putting'].map((focus) => <Pressable key={focus} onPress={() => setPracticeFocus(focus)} style={[styles.practiceChoice, practiceFocus === focus && styles.practiceChoiceSelected]}><View style={styles.practiceChoiceCopy}><Text style={styles.practiceChoiceTitle}>{focus}</Text><Text style={styles.practiceChoiceSubtitle}>{focus === 'Distance' ? 'Build a baseline for each disc' : focus === 'Accuracy' ? 'Work on landing near your target' : 'Track short throws and touch'}</Text></View><Text style={styles.practiceChoiceMark}>{practiceFocus === focus ? '✓' : '○'}</Text></Pressable>)}
      <Pressable onPress={startPractice} style={styles.primaryButton}><Text style={styles.primaryButtonText}>START {practiceFocus.toUpperCase()} PRACTICE ↗</Text></Pressable>
    </ScrollView>
  </>;
};
