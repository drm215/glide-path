import { Pressable, Text, View } from 'react-native';
import { useApp, type Screen } from '../state/AppState';
import { styles } from '../theme';
import { HoldPressable } from './HoldPressable';

export type Back = { to: Screen; label: string; name: string };

export const HOME_BACK: Back = { to: 'Home', label: '⌂ MENU', name: 'the main menu' };
export const COURSES_BACK: Back = { to: 'CourseBuilder', label: '‹ COURSES', name: 'course builder' };
export const NEW_COURSE_BACK: Back = { to: 'NewCourse', label: '‹ NEW COURSE', name: 'the new course' };
export const ROUNDS_BACK: Back = { to: 'Rounds', label: '‹ ROUNDS', name: 'rounds' };

// A screen's eyebrow, title and back button. The round screen shows only the back button
// (`compact`), and it needs a hold there like every other round button.
export const ScreenHeading = ({ eyebrow, title, back = HOME_BACK, compact = false, hold = false }: {
  eyebrow?: string; title?: string; back?: Back | null; compact?: boolean; hold?: boolean;
}) => {
  const { navigate } = useApp();
  const Button = hold ? HoldPressable : Pressable;
  return (
    <View style={[styles.pageHeading, compact && styles.pageHeadingCompact]}>
      {!compact && <View>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        <Text style={styles.title}>{title}</Text>
      </View>}
      {back && <Button onPress={() => navigate(back.to)} style={styles.homeButton} accessibilityRole="button" accessibilityLabel={`Back to ${back.name}`}>
        <Text style={styles.homeButtonText}>{back.label}</Text>
      </Button>}
    </View>
  );
};
